import { describe, it, expect } from 'vitest';
import { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';

describe('SERVER_TOOLS', () => {
  it('includes datetime tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:datetime' });
  });

  it('includes web search tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_search' });
  });

  it('includes web fetch tool', () => {
    expect(SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_fetch' });
  });
});

describe('createServerToolsHooks', () => {
  it('returns an SDKHooks instance with both beforeCreateRequest and afterError hooks', () => {
    const hooks = createServerToolsHooks();
    expect(hooks).toBeDefined();
    expect(hooks.beforeCreateRequestHooks).toHaveLength(1);
    expect(hooks.afterErrorHooks).toHaveLength(1);
  });

  it('appends server tools to request body', () => {
    const hooks = createServerToolsHooks();
    const body = JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'f1' }] });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(1 + SERVER_TOOLS.length);
    expect(parsed.tools[0].name).toBe('f1');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:datetime');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_search');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_fetch');
  });

  it('creates tools array when none exists', () => {
    const hooks = createServerToolsHooks();
    const body = JSON.stringify({ model: 'test' });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(SERVER_TOOLS.length);
  });

  it('passes through when body is not a string', () => {
    const hooks = createServerToolsHooks();
    const input = { url: new URL('https://example.com'), options: {} };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    expect(result).toEqual(input);
  });

  it('returns input unchanged when body is not valid JSON', () => {
    const hooks = createServerToolsHooks();
    const input = {
      url: new URL('https://example.com'),
      options: { body: 'not json{' },
    };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    expect(result).toBe(input);
    expect((result as { options: { body: string } }).options.body).toBe('not json{');
  });
});

describe('createServerToolsHooks — afterError hook', () => {
  // Helper that calls the registered afterError hook directly.
  async function callAfterError(
    response: Response | null,
    error: unknown,
  ): Promise<{ response: Response | null; error: unknown }> {
    const hooks = createServerToolsHooks();
    // The hook is registered as the first (and only) afterErrorHook.
    const hook = hooks.afterErrorHooks[0];
    return hook.afterError({} as Parameters<typeof hook.afterError>[0], response, error);
  }

  it('passes through when an error object is already present', async () => {
    const existing = new Error('already an error');
    const fakeResponse = new Response('{}', { status: 402 });
    const result = await callAfterError(fakeResponse, existing);
    expect(result.error).toBe(existing);
    expect(result.response).toBe(fakeResponse);
  });

  it('builds an error from JSON body with error.message field on non-2xx response', async () => {
    const body = JSON.stringify({
      error: {
        message:
          'This request requires more credits. You requested up to 65536 tokens, but can only afford 62298.',
      },
    });
    const response = new Response(body, {
      status: 402,
      statusText: 'Payment Required',
    });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    const msg = (result.error as Error).message;
    expect(msg).toContain('OpenRouter request failed (402)');
    expect(msg).toContain('can only afford 62298');
  });

  it('falls back to top-level message field when error.message is absent', async () => {
    const body = JSON.stringify({ message: 'Unauthorized' });
    const response = new Response(body, { status: 401, statusText: 'Unauthorized' });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('Unauthorized');
  });

  it('falls back to raw body text when JSON has no message fields', async () => {
    const body = 'raw error body';
    const response = new Response(body, { status: 500, statusText: 'Internal Server Error' });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('raw error body');
  });

  it('falls back to statusText when body is empty', async () => {
    const response = new Response('', { status: 403, statusText: 'Forbidden' });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    const msg = (result.error as Error).message;
    expect(msg).toContain('OpenRouter request failed (403)');
    expect(msg).toContain('Forbidden');
  });

  it('handles null response gracefully', async () => {
    const result = await callAfterError(null, null);
    expect(result.error).toBeInstanceOf(Error);
    const msg = (result.error as Error).message;
    expect(msg).toContain('OpenRouter request failed (0)');
  });

  it('error message includes the HTTP status code', async () => {
    const body = JSON.stringify({ error: { message: 'over quota' } });
    const response = new Response(body, { status: 429, statusText: 'Too Many Requests' });
    const result = await callAfterError(response, null);
    expect((result.error as Error).message).toMatch(/429/);
    expect((result.error as Error).message).toContain('over quota');
  });
});
