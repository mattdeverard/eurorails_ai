# Deploying EuroRails to Google Cloud (showcase)

This deploys the EuroRails app to **Cloud Run**, backed by **Cloud SQL (PostgreSQL)**,
with secrets in **Secret Manager** and CI/CD from GitHub Actions via **Workload
Identity Federation** (no long-lived service-account keys).

Chat moderation runs on the **Gemini API** (no self-hosted model server).

## Architecture

```
GitHub (mattdeverard/eurorails_ai)
   └─ push to main ─▶ GitHub Actions (deploy-gcp.yml)
                        │  auth via Workload Identity Federation
                        ▼
                     Cloud Build / Docker  ──▶ Artifact Registry
                        │
                        ▼
                     Cloud Run service ──▶ Cloud SQL (PostgreSQL, unix socket)
                        │                └▶ Secret Manager (DB pwd, keys)
                        └▶ Gemini API (chat moderation)
```

The single container (`Dockerfile.prod`) serves both the Phaser client and the
Express API. The app listens on `$PORT` (Cloud Run sets `8080`) and exposes
`/health`.

## Prerequisites

- `gcloud` CLI installed and authenticated:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```
- A GCP project for the showcase (e.g. `eurorails-showcase`). Billed to the
  compounds Google for Startups credits.
- Admin on the GitHub repo `mattdeverard/eurorails_ai`.

## 1. Provision GCP (one time)

```bash
PROJECT_ID=eurorails-showcase ./scripts/gcp/setup.sh
```

This is idempotent — re-run it any time. It creates the Artifact Registry repo,
Cloud SQL instance + database + user, Secret Manager secrets, the Cloud Run
runtime service account, and the deployer service account + Workload Identity
Federation binding restricted to this GitHub repo.

Override defaults via env vars (see the top of `scripts/gcp/setup.sh`):
`REGION`, `SQL_TIER`, `DB_NAME`, `GITHUB_REPO`, etc.

## 2. Fill in the API keys

The bootstrap creates the secrets with placeholder values. Set the real ones:

```bash
printf 'YOUR_GEMINI_KEY'    | gcloud secrets versions add eurorails-google-ai-key --data-file=-
printf 'YOUR_ANTHROPIC_KEY' | gcloud secrets versions add eurorails-anthropic-key --data-file=-
printf 'YOUR_RESEND_KEY'    | gcloud secrets versions add eurorails-resend-key   --data-file=-   # optional (email)
```

`eurorails-db-password` and `eurorails-session-secret` are generated automatically.

## 3. Configure GitHub

In **Settings → Secrets and variables → Actions**, add what `setup.sh` printed:

| Variables | Secrets |
|-----------|---------|
| `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE_NAME`, `GCP_AR_REPO` | `GCP_WIF_PROVIDER` |
| `GCP_SQL_CONNECTION_NAME`, `GCP_DB_NAME`, `GCP_DB_USER`, `GCP_RUNTIME_SA` | `GCP_DEPLOYER_SA` |
| `PUBLIC_URL` (set after first deploy — see below) | |

## 4. First deploy

`PUBLIC_URL` is baked into the client bundle at build time (for CORS and the API
base URL), but you don't know the Cloud Run URL until the service exists. So:

1. Set `PUBLIC_URL` to a placeholder (or leave it empty) and trigger the workflow
   (push to `main`, or **Actions → Deploy to Cloud Run → Run workflow**).
2. The final step prints the service URL, e.g. `https://eurorails-xxxx-uc.a.run.app`.
3. Set the `PUBLIC_URL` variable to that URL.
4. Re-run the workflow so the client bundle is built with the correct origin.

To skip the two-step dance, map a **custom domain** first (Cloud Run → Manage
custom domains, or `gcloud run domain-mappings create`), set `PUBLIC_URL` to that
domain, and deploy once.

## 5. Database schema

The app initializes its schema on startup (`checkDatabase()` in `src/server/db`).
On the first deploy against the empty Cloud SQL database it will create the
required tables. Watch the Cloud Run logs on the first revision to confirm.

## Costs (showcase scale)

- **Cloud Run**: scales to zero (`--min-instances=0`); you pay only per request.
  Cold starts add latency — set `--min-instances=1` if the demo must be instant.
- **Cloud SQL `db-f1-micro`**: always-on, the main fixed cost (~a few dollars/mo).
  Stoppable when not demoing: `gcloud sql instances patch eurorails-db --activation-policy=NEVER`.
- **Gemini API + Secret Manager + Artifact Registry**: negligible at this scale.

No GPU, no always-on model server — the previous Ollama/Llama Guard sidecar was
removed in favor of the Gemini API.

## Local development

`docker-compose up` still runs Postgres + the app locally. Moderation now needs a
`GOOGLE_AI_API_KEY` in your `.env` (see `.env.example`); there is no local Ollama.

## Rolling back

Cloud Run keeps every revision:

```bash
gcloud run revisions list --service=eurorails --region=<region>
gcloud run services update-traffic eurorails --region=<region> --to-revisions=<REVISION>=100
```
