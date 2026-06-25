import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accountInfo,
  supportedModels,
  ModelContextLengthCache,
  MODEL_CONTEXT_LENGTH_CACHE_TTL_MS,
} from './openrouter-api.js';

const FIXTURES = join(import.meta.dirname, '__tests__/fixtures/openrouter-api');

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function mockResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accountInfo', () => {
  it('returns AccountInfo on 200', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('auth-key-valid.json')));

    const info = await accountInfo({ apiKey: 'sk-test' });

    expect(info).toEqual({
      provider: 'openrouter',
      label: 'sk-or-v1-test-key',
      usageUsd: 12.3456,
      limitUsd: 50.0,
    });
  });

  it('falls back to defaults when usage/limit/label have wrong types', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('auth-key-wrong-types.json')));

    const info = await accountInfo({ apiKey: 'sk-test' });

    expect(info).toEqual({
      provider: 'openrouter',
      label: '',
      usageUsd: 0,
      limitUsd: null,
    });
  });

  it('parses null limit as null', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ data: { label: 'free', usage: 1.5, limit: null } }),
    );

    const info = await accountInfo({ apiKey: 'sk-test' });

    expect(info).not.toBeNull();
    expect(info!.limitUsd).toBeNull();
    expect(info!.usageUsd).toBe(1.5);
  });

  it('returns null on 401', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(readFixture('auth-key-401.json'), { status: 401, statusText: 'Unauthorized' }),
    );

    const info = await accountInfo({ apiKey: 'bad' });

    expect(info).toBeNull();
  });

  it('returns null on 403', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ error: { code: 403 } }, { status: 403, statusText: 'Forbidden' }),
    );

    const info = await accountInfo({ apiKey: 'bad' });

    expect(info).toBeNull();
  });

  it('throws on 500 with URL and status in message', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({}, { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(accountInfo({ apiKey: 'sk-test' })).rejects.toThrow(
      /https:\/\/openrouter\.ai\/api\/v1\/auth\/key.*500.*Internal Server Error/,
    );
  });

  it('sends Authorization: Bearer <key>', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('auth-key-valid.json')));

    await accountInfo({ apiKey: 'sk-test-123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
  });

  it('uses default baseUrl when none provided', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('auth-key-valid.json')));

    await accountInfo({ apiKey: 'sk-test' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/auth/key',
      expect.any(Object),
    );
  });

  it('uses baseUrl override', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('auth-key-valid.json')));

    await accountInfo({ apiKey: 'sk-test', baseUrl: 'https://staging.example.com/api/v1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://staging.example.com/api/v1/auth/key',
      expect.any(Object),
    );
  });
});

describe('supportedModels', () => {
  it('maps /models data[] to ModelInfo[]', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));

    const models = await supportedModels({ apiKey: 'sk-test' });

    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      value: 'anthropic/claude-sonnet-4.5',
      displayName: 'Anthropic: Claude Sonnet 4.5',
      description:
        "Claude Sonnet 4.5 is Anthropic's mid-tier model optimized for coding and tool use.",
    });
  });

  it('falls back to id for displayName when name is missing', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));

    const models = await supportedModels({ apiKey: 'sk-test' });
    const gemini = models.find((m) => m.value === 'google/gemini-2.5-pro')!;

    expect(gemini.displayName).toBe('google/gemini-2.5-pro');
    expect(gemini.description).toBe("Gemini 2.5 Pro is Google's frontier reasoning model.");
  });

  it('falls back to empty string for missing description', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ data: [{ id: 'foo/bar', name: 'Foo Bar' }] }));

    const models = await supportedModels({ apiKey: 'sk-test' });

    expect(models).toEqual([{ value: 'foo/bar', displayName: 'Foo Bar', description: '' }]);
  });

  it('throws on 401 (not nullable)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ error: { code: 401 } }, { status: 401, statusText: 'Unauthorized' }),
    );

    await expect(supportedModels({ apiKey: 'bad' })).rejects.toThrow(
      /https:\/\/openrouter\.ai\/api\/v1\/models.*401.*Unauthorized/,
    );
  });

  it('throws on 500 with URL and status in message', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({}, { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(supportedModels({ apiKey: 'sk-test' })).rejects.toThrow(
      /https:\/\/openrouter\.ai\/api\/v1\/models.*500/,
    );
  });

  it('sends Authorization: Bearer <key>', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));

    await supportedModels({ apiKey: 'sk-test-456' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-456');
  });

  it('uses baseUrl override', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));

    await supportedModels({ apiKey: 'sk-test', baseUrl: 'https://staging.example.com/api/v1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://staging.example.com/api/v1/models',
      expect.any(Object),
    );
  });

  it('returns empty array when data missing', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}));

    const models = await supportedModels({ apiKey: 'sk-test' });

    expect(models).toEqual([]);
  });
});

describe('ModelContextLengthCache', () => {
  it('exposes a sane default TTL constant', () => {
    expect(MODEL_CONTEXT_LENGTH_CACHE_TTL_MS).toBe(10 * 60_000);
  });

  it('resolves context_length for a known model from the catalogue', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    expect(win).toBe(200000);
  });

  it("strips a leading '~' alias marker and re-tries", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: '~openai/gpt-4o', apiKey: 'sk-test' });
    expect(win).toBe(128000);
  });

  it('returns null for an unknown model', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: 'nobody/unknown-9000', apiKey: 'sk-test' });
    expect(win).toBeNull();
  });

  it('returns null (not throw) on a network error — failure-tolerant', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    expect(win).toBeNull();
  });

  it('returns null (not throw) on a non-200 response', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}, { status: 500 }));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    expect(win).toBeNull();
  });

  it('returns null on a malformed body (data not an array)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ data: 'oops' }));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    expect(win).toBeNull();
  });

  it('ignores entries with a missing / non-positive context_length', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        data: [
          { id: 'a/zero', context_length: 0 },
          { id: 'a/missing' },
          { id: 'a/good', context_length: 64000 },
        ],
      }),
    );
    const cache = new ModelContextLengthCache();
    expect(await cache.get({ model: 'a/zero', apiKey: 'sk-test' })).toBeNull();
    // Same cache entry (one fetch) — subsequent lookups are memoized.
    expect(await cache.get({ model: 'a/missing', apiKey: 'sk-test' })).toBeNull();
    expect(await cache.get({ model: 'a/good', apiKey: 'sk-test' })).toBe(64000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the catalogue within the TTL (single fetch for repeated lookups)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    await cache.get({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    let now = 0;
    fetchMock.mockResolvedValue(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache({ ttlMs: 1000, now: () => now });
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    now = 2000; // past the TTL
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a failed fetch (re-attempts on the next call)', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    expect(await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' })).toBeNull();
    // Second call re-attempts (failure not pinned) and succeeds.
    expect(await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' })).toBe(128000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by base URL (staging vs prod do not collide)', async () => {
    fetchMock.mockResolvedValue(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    await cache.get({
      model: 'openai/gpt-4o',
      apiKey: 'sk-test',
      baseUrl: 'https://staging.example.com/api/v1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://staging.example.com/api/v1/models',
      expect.any(Object),
    );
  });

  it('clear() forces a re-fetch', async () => {
    fetchMock.mockResolvedValue(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    cache.clear();
    await cache.get({ model: 'openai/gpt-4o', apiKey: 'sk-test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a custom fetch impl when provided', async () => {
    const customFetch = vi.fn().mockResolvedValue(mockResponse(readFixture('models-200.json')));
    const cache = new ModelContextLengthCache();
    const win = await cache.get({
      model: 'openai/gpt-4o',
      apiKey: 'sk-test',
      fetchImpl: customFetch as unknown as typeof fetch,
    });
    expect(win).toBe(128000);
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
