/**
 * ModerationService Unit Tests
 * Tests for content moderation via Google's Gemini API.
 * The model returns a structured JSON verdict { safe, categories }.
 */

import { ModerationService } from '../services/moderationService';

// Helper to create a mock fetch response
function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// Helper to build a Gemini generateContent response wrapping a verdict object
function mockGeminiVerdict(verdict: { safe: boolean; categories: string[] }): Response {
  return mockFetchResponse({
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(verdict) }] },
        finishReason: 'STOP',
      },
    ],
  });
}

describe('ModerationService', () => {
  let service: ModerationService;
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_AI_API_KEY: 'test-api-key',
      MODERATION_MODEL: 'gemini-2.0-flash',
    };
    service = new ModerationService();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('initialize', () => {
    it('should initialize successfully when the model is reachable', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ name: 'models/gemini-2.0-flash' })
      );

      await service.initialize(1000);

      expect(service.isReady()).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash?key=test-api-key',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should skip if already initialized', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ name: 'models/gemini-2.0-flash' })
      );

      await service.initialize(1000);
      await service.initialize(1000);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should throw when no API key is configured', async () => {
      delete process.env.GOOGLE_AI_API_KEY;
      service = new ModerationService();

      await expect(service.initialize(1000)).rejects.toThrow(
        'MODERATION_INITIALIZATION_FAILED'
      );
      expect(service.isReady()).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should throw when the API is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.initialize(0)).rejects.toThrow(
        'MODERATION_INITIALIZATION_FAILED'
      );
      expect(service.isReady()).toBe(false);
    });

    it('should throw when model is not found', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ error: 'model not found' }, 404)
      );

      await expect(service.initialize(0)).rejects.toThrow(
        'MODERATION_INITIALIZATION_FAILED'
      );
      expect(service.isReady()).toBe(false);
    });
  });

  describe('checkMessage', () => {
    beforeEach(async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ name: 'models/gemini-2.0-flash' })
      );
      await service.initialize(1000);
    });

    it('should reject empty messages', async () => {
      const result = await service.checkMessage('');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual([]);
    });

    it('should reject whitespace-only messages', async () => {
      const result = await service.checkMessage('   ');

      expect(result.isAppropriate).toBe(false);
    });

    it('should approve safe messages', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockGeminiVerdict({ safe: true, categories: [] })
      );

      const result = await service.checkMessage('Hello, how are you?');

      expect(result.isAppropriate).toBe(true);
      expect(result.violatedCategories).toEqual([]);
    });

    it('should reject unsafe messages with category', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockGeminiVerdict({ safe: false, categories: ['S10'] })
      );

      const result = await service.checkMessage('some hateful content');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual(['S10']);
    });

    it('should reject unsafe messages with multiple categories', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockGeminiVerdict({ safe: false, categories: ['S1', 'S10'] })
      );

      const result = await service.checkMessage('violent and hateful content');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual(['S1', 'S10']);
    });

    it('should reject when Gemini blocks the prompt', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ promptFeedback: { blockReason: 'SAFETY' } })
      );

      const result = await service.checkMessage('blocked content');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual([]);
    });

    it('should fail closed on API error', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ error: 'internal error' }, 500)
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should fail closed on network error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('ECONNREFUSED')
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should fail closed on unparseable response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({
          candidates: [{ content: { parts: [{ text: 'gibberish output' }] } }],
        })
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should send correct request format to Gemini', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockGeminiVerdict({ safe: true, categories: [] })
      );

      await service.checkMessage('Hello world');

      const generateCall = (global.fetch as jest.Mock).mock.calls.find(
        (call: any[]) => call[0].includes(':generateContent')
      );
      expect(generateCall).toBeDefined();

      const body = JSON.parse(generateCall[1].body);
      expect(body.contents[0].parts[0].text).toContain('Hello world');
      expect(body.systemInstruction.parts[0].text).toContain(
        '<BEGIN UNSAFE CONTENT CATEGORIES>'
      );
      expect(body.systemInstruction.parts[0].text).toContain(
        '<END UNSAFE CONTENT CATEGORIES>'
      );
      expect(body.generationConfig.responseMimeType).toBe('application/json');
    });
  });

  describe('checkMessage - not initialized', () => {
    it('should throw MODERATION_NOT_INITIALIZED', async () => {
      await expect(service.checkMessage('test')).rejects.toThrow(
        'MODERATION_NOT_INITIALIZED'
      );
    });
  });

  describe('getHealthStatus', () => {
    it('should return provider config', () => {
      const status = service.getHealthStatus();

      expect(status.initialized).toBe(false);
      expect(status.provider).toBe('google-gemini');
      expect(status.modelName).toBe('gemini-2.0-flash');
    });
  });
});
