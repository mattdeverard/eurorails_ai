/**
 * Service for content moderation using Google's Gemini API.
 *
 * Local dev & production both call the Gemini Developer API directly over HTTPS
 * (https://generativelanguage.googleapis.com), authenticated with GOOGLE_AI_API_KEY.
 * No self-hosted model server is required.
 *
 * The model is prompted to act as a Llama-Guard-style classifier and return a
 * structured JSON verdict: { safe: boolean, categories: string[] }. We pass the
 * model's decision through directly. Gemini's own safety filters are disabled
 * (BLOCK_NONE) so the model evaluates and classifies borderline content rather
 * than refusing to respond.
 */

/**
 * Unsafe content taxonomy. Category codes (S1–S13) are kept identical to the
 * previous Llama Guard 3 policy so downstream consumers of `violatedCategories`
 * see a stable vocabulary.
 */
const UNSAFE_CONTENT_CATEGORIES = `S1: Violent Crimes.
S2: Non-Violent Crimes.
S3: Sex Crimes.
S4: Child Exploitation.
S5: Defamation.
S6: Specialized Advice.
S7: Privacy.
S8: Intellectual Property.
S9: Indiscriminate Weapons.
S10: Hate.
S11: Self-Harm.
S12: Sexual Content.
S13: Elections.`;

export class ModerationService {
  private apiBaseUrl: string;
  private apiKey: string;
  private modelName: string;
  private isInitialized: boolean = false;

  constructor() {
    this.apiBaseUrl =
      process.env.GOOGLE_AI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = process.env.GOOGLE_AI_API_KEY || '';
    this.modelName = process.env.MODERATION_MODEL || 'gemini-2.0-flash';
  }

  /**
   * Initialize the moderation service by verifying the configured Gemini model
   * is reachable. Polls the model metadata endpoint, retrying on transient
   * failures for up to maxWaitMs. Throws if no API key is configured or the
   * model does not become reachable within the timeout.
   */
  async initialize(maxWaitMs: number = 60_000): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (!this.apiKey) {
      throw new Error(
        'MODERATION_INITIALIZATION_FAILED: GOOGLE_AI_API_KEY is not set'
      );
    }

    const intervalMs = 5_000;
    const startTime = Date.now();

    console.log(
      `[Moderation] Verifying Gemini model ${this.modelName} (timeout: ${maxWaitMs / 1000}s)...`
    );

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const response = await fetch(
          `${this.apiBaseUrl}/models/${this.modelName}?key=${this.apiKey}`,
          { method: 'GET' }
        );

        if (response.ok) {
          this.isInitialized = true;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(
            `[Moderation] Gemini model ${this.modelName} is available (took ${elapsed}s)`
          );
          return;
        }

        console.log(
          `[Moderation] Model not ready (${response.status}), retrying...`
        );
      } catch (error) {
        console.log('[Moderation] Gemini API not reachable, retrying...');
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      'MODERATION_INITIALIZATION_FAILED: Gemini model not available within timeout'
    );
  }

  /**
   * Check if a message is appropriate using Gemini.
   * Returns { isAppropriate, violatedCategories }.
   */
  async checkMessage(
    text: string
  ): Promise<{ isAppropriate: boolean; violatedCategories: string[] }> {
    if (!this.isInitialized) {
      throw new Error('MODERATION_NOT_INITIALIZED');
    }

    // Basic validation
    if (!text || text.trim().length === 0) {
      console.log('[Moderation] Empty message rejected');
      return { isAppropriate: false, violatedCategories: [] };
    }

    try {
      const requestBody = this.buildModerationRequest(text);

      const response = await fetch(
        `${this.apiBaseUrl}/models/${this.modelName}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API returned ${response.status}`);
      }

      const data = await response.json();
      const parsed = this.parseGeminiResponse(data);

      if (!parsed.safe) {
        console.log('[Moderation] Message rejected:', {
          violatedCategories: parsed.categories,
        });
      }

      return {
        isAppropriate: parsed.safe,
        violatedCategories: parsed.categories,
      };
    } catch (error) {
      console.error('[Moderation] Error during moderation check:', error);
      // Fail closed: reject on error
      return { isAppropriate: false, violatedCategories: [] };
    }
  }

  /**
   * Build the Gemini generateContent request body for content moderation.
   * Uses structured JSON output and disables Gemini's own safety filtering so
   * the model returns a classification verdict rather than refusing.
   */
  private buildModerationRequest(userMessage: string): Record<string, unknown> {
    const systemInstruction = `Task: Check if there is unsafe content in the 'User' message according to our safety policy with the below categories.

<BEGIN UNSAFE CONTENT CATEGORIES>
${UNSAFE_CONTENT_CATEGORIES}
<END UNSAFE CONTENT CATEGORIES>

Respond with a JSON object: set "safe" to true if the message is safe, or false if it violates any category. If unsafe, list the violated category codes (e.g. "S10") in "categories"; otherwise use an empty array.`;

    const safetyCategories = [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ];

    return {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: `User: ${userMessage}` }],
        },
      ],
      safetySettings: safetyCategories.map(category => ({
        category,
        threshold: 'BLOCK_NONE',
      })),
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            safe: { type: 'boolean' },
            categories: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['safe', 'categories'],
        },
      },
    };
  }

  /**
   * Parse Gemini's generateContent response into a moderation verdict.
   * Expects the candidate text to be a JSON object { safe, categories }.
   * If Gemini blocked the prompt/response outright, treat it as unsafe.
   * Throws on an unparseable response to trigger fail-closed handling.
   */
  private parseGeminiResponse(data: any): { safe: boolean; categories: string[] } {
    // If Gemini blocked the prompt itself, treat the content as unsafe.
    if (data?.promptFeedback?.blockReason) {
      return { safe: false, categories: [] };
    }

    const candidate = data?.candidates?.[0];

    // A candidate terminated for safety reasons is unsafe by definition.
    if (candidate?.finishReason === 'SAFETY') {
      return { safe: false, categories: [] };
    }

    const responseText = candidate?.content?.parts?.[0]?.text;

    if (!responseText) {
      console.error('[Moderation] No content in model response:', data);
      throw new Error('Unparseable model response');
    }

    let parsed: { safe?: unknown; categories?: unknown };
    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      console.error('[Moderation] Could not parse model response:', responseText);
      throw new Error('Unparseable model response');
    }

    if (typeof parsed.safe !== 'boolean') {
      console.error('[Moderation] Model response missing "safe" boolean:', parsed);
      throw new Error('Unparseable model response');
    }

    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.map(c => String(c).trim()).filter(Boolean)
      : [];

    return { safe: parsed.safe, categories };
  }

  /**
   * Get health status of moderation service
   */
  getHealthStatus(): {
    initialized: boolean;
    provider: string;
    modelName: string;
  } {
    return {
      initialized: this.isInitialized,
      provider: 'google-gemini',
      modelName: this.modelName,
    };
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const moderationService = new ModerationService();
