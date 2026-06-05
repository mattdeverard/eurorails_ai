#!/usr/bin/env bash
#
# One-time GCP bootstrap for the EuroRails showcase deployment.
#
# Provisions everything the GitHub Actions deploy workflow (.github/workflows/deploy-gcp.yml)
# needs to push the app to Cloud Run:
#   - Required GCP APIs
#   - Artifact Registry repo (container images)
#   - Cloud SQL for PostgreSQL instance + database + app user
#   - Secret Manager secrets (DB password, session secret, API keys)
#   - A runtime service account for Cloud Run
#   - A deployer service account + Workload Identity Federation bound to the GitHub repo
#
# Idempotent: safe to re-run. Existing resources are detected and skipped.
#
# Prerequisites:
#   gcloud auth login
#   gcloud auth application-default login
#
# Usage:
#   PROJECT_ID=eurorails-showcase ./scripts/gcp/setup.sh
#
set -euo pipefail

# ---- Configuration (override via environment) --------------------------------
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID (e.g. PROJECT_ID=eurorails-showcase)}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-eurorails}"
AR_REPO="${AR_REPO:-eurorails}"

SQL_INSTANCE="${SQL_INSTANCE:-eurorails-db}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"
DB_NAME="${DB_NAME:-eurorails}"
DB_USER="${DB_USER:-eurorails}"

# GitHub repo allowed to deploy via Workload Identity Federation.
GITHUB_REPO="${GITHUB_REPO:-mattdeverard/eurorails_ai}"

RUNTIME_SA="${RUNTIME_SA:-eurorails-run}"
DEPLOYER_SA="${DEPLOYER_SA:-eurorails-deployer}"
WIF_POOL="${WIF_POOL:-github-pool}"
WIF_PROVIDER="${WIF_PROVIDER:-github-provider}"

# Secret names in Secret Manager.
SECRET_DB_PASSWORD="eurorails-db-password"
SECRET_SESSION="eurorails-session-secret"
SECRET_GOOGLE_AI="eurorails-google-ai-key"
SECRET_ANTHROPIC="eurorails-anthropic-key"
SECRET_RESEND="eurorails-resend-key"

RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA_EMAIL="${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

log()  { printf '\n\033[1;94m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;92m  ✓ %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

# ---- 1. Enable APIs ----------------------------------------------------------
log "Enabling required APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudbuild.googleapis.com \
  generativelanguage.googleapis.com \
  --quiet
ok "APIs enabled"

# ---- 2. Artifact Registry ----------------------------------------------------
log "Artifact Registry repo: $AR_REPO ($REGION)"
if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
  ok "repo already exists"
else
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker --location="$REGION" \
    --description="EuroRails container images"
  ok "repo created"
fi

# ---- 3. Cloud SQL (PostgreSQL) ----------------------------------------------
log "Cloud SQL instance: $SQL_INSTANCE ($SQL_TIER)"
if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  ok "instance already exists"
else
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --storage-auto-increase \
    --edition=ENTERPRISE
  ok "instance created"
fi

INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"

log "Database: $DB_NAME"
if gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
  ok "database already exists"
else
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
  ok "database created"
fi

# DB password: reuse the Secret Manager value if it exists, otherwise generate one.
log "Database user: $DB_USER"
if gcloud secrets describe "$SECRET_DB_PASSWORD" >/dev/null 2>&1; then
  DB_PASSWORD="$(gcloud secrets versions access latest --secret="$SECRET_DB_PASSWORD")"
  ok "reusing existing DB password from Secret Manager"
else
  DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  printf '%s' "$DB_PASSWORD" | gcloud secrets create "$SECRET_DB_PASSWORD" --data-file=- --replication-policy=automatic
  ok "generated DB password and stored in Secret Manager"
fi

if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  ok "DB user password synced"
else
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  ok "DB user created"
fi

# ---- 4. Secret Manager (app secrets) ----------------------------------------
# Creates each secret if missing. Placeholder values are written for keys you must
# fill in; rotate them with: gcloud secrets versions add <name> --data-file=-
create_secret_if_missing() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    ok "secret $name already exists (left unchanged)"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic
    ok "secret $name created"
  fi
}

log "Secret Manager secrets"
create_secret_if_missing "$SECRET_SESSION" "$(openssl rand -hex 32)"
create_secret_if_missing "$SECRET_GOOGLE_AI" "REPLACE_ME"
create_secret_if_missing "$SECRET_ANTHROPIC" "REPLACE_ME"
create_secret_if_missing "$SECRET_RESEND" "REPLACE_ME"

# ---- 5. Runtime service account (Cloud Run identity) -------------------------
log "Runtime service account: $RUNTIME_SA_EMAIL"
if gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" >/dev/null 2>&1; then
  ok "already exists"
else
  gcloud iam service-accounts create "$RUNTIME_SA" --display-name="EuroRails Cloud Run runtime"
  ok "created"
fi

# Runtime SA needs Cloud SQL access + secret access.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" --role="roles/cloudsql.client" --condition=None --quiet >/dev/null
for secret in "$SECRET_DB_PASSWORD" "$SECRET_SESSION" "$SECRET_GOOGLE_AI" "$SECRET_ANTHROPIC" "$SECRET_RESEND"; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" --role="roles/secretmanager.secretAccessor" --quiet >/dev/null
done
ok "runtime SA granted cloudsql.client + secretAccessor"

# ---- 6. Deployer service account + Workload Identity Federation --------------
log "Deployer service account: $DEPLOYER_SA_EMAIL"
if gcloud iam service-accounts describe "$DEPLOYER_SA_EMAIL" >/dev/null 2>&1; then
  ok "already exists"
else
  gcloud iam service-accounts create "$DEPLOYER_SA" --display-name="EuroRails GitHub Actions deployer"
  ok "created"
fi

for role in roles/run.admin roles/artifactregistry.writer roles/cloudsql.client roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_SA_EMAIL}" --role="$role" --condition=None --quiet >/dev/null
done
# Deployer must be able to act as the runtime SA when deploying Cloud Run.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" \
  --member="serviceAccount:${DEPLOYER_SA_EMAIL}" --role="roles/iam.serviceAccountUser" --quiet >/dev/null
ok "deployer SA granted run.admin + artifactregistry.writer + cloudsql.client + serviceAccountUser"

log "Workload Identity Federation pool/provider"
if gcloud iam workload-identity-pools describe "$WIF_POOL" --location=global >/dev/null 2>&1; then
  ok "pool already exists"
else
  gcloud iam workload-identity-pools create "$WIF_POOL" \
    --location=global --display-name="GitHub Actions pool"
  ok "pool created"
fi

if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --location=global --workload-identity-pool="$WIF_POOL" >/dev/null 2>&1; then
  ok "provider already exists"
else
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --location=global --workload-identity-pool="$WIF_POOL" \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
  ok "provider created (restricted to ${GITHUB_REPO})"
fi

WIF_POOL_ID="$(gcloud iam workload-identity-pools describe "$WIF_POOL" --location=global --format='value(name)')"
# Allow the GitHub repo's tokens to impersonate the deployer SA.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}" --quiet >/dev/null
ok "GitHub repo bound to deployer SA"

WIF_PROVIDER_RESOURCE="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
  --location=global --workload-identity-pool="$WIF_POOL" --format='value(name)')"

# ---- Summary -----------------------------------------------------------------
cat <<EOF

\033[1;92m═══ Bootstrap complete ═══\033[0m

Set these as GitHub repository variables/secrets (Settings → Secrets and variables → Actions):

  Variables:
    GCP_PROJECT_ID              = ${PROJECT_ID}
    GCP_REGION                  = ${REGION}
    GCP_SERVICE_NAME            = ${SERVICE_NAME}
    GCP_AR_REPO                 = ${AR_REPO}
    GCP_SQL_CONNECTION_NAME     = ${INSTANCE_CONNECTION_NAME}
    GCP_DB_NAME                 = ${DB_NAME}
    GCP_DB_USER                 = ${DB_USER}
    GCP_RUNTIME_SA             = ${RUNTIME_SA_EMAIL}
    PUBLIC_URL                  = (your final Cloud Run URL or custom domain)

  Secrets:
    GCP_WIF_PROVIDER            = ${WIF_PROVIDER_RESOURCE}
    GCP_DEPLOYER_SA            = ${DEPLOYER_SA_EMAIL}

Next:
  1. Fill in the real API keys:
       printf 'YOUR_KEY' | gcloud secrets versions add ${SECRET_GOOGLE_AI} --data-file=-
       printf 'YOUR_KEY' | gcloud secrets versions add ${SECRET_ANTHROPIC} --data-file=-
       printf 'YOUR_KEY' | gcloud secrets versions add ${SECRET_RESEND} --data-file=-   # optional
  2. Push to the deploy branch (or run the workflow manually) to deploy.
  3. After the first deploy, set PUBLIC_URL to the Cloud Run URL and redeploy
     (the client bundle bakes it in at build time for CORS + API base URL).

EOF
