import { describe, it, expect } from 'vitest';
import { DEFAULT_SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';

describe('DEFAULT_SERVER_TOOLS', () => {
  it('includes datetime tool', () => {
    expect(DEFAULT_SERVER_TOOLS).toContainEqual({ type: 'openrouter:datetime' });
  });

  it('includes web search tool', () => {
    expect(DEFAULT_SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_search' });
  });

  it('includes web fetch tool', () => {
    expect(DEFAULT_SERVER_TOOLS).toContainEqual({ type: 'openrouter:web_fetch' });
  });
});

describe('createServerToolsHooks', () => {
  it('returns an SDKHooks instance with both beforeCreateRequest and afterError hooks', () => {
    const hooks = createServerToolsHooks();
    expect(hooks).toBeDefined();
    expect(hooks.beforeCreateRequestHooks).toHaveLength(1);
    expect(hooks.afterErrorHooks).toHaveLength(1);
  });

  it('appends the default server tools to request body', () => {
    const hooks = createServerToolsHooks();
    const body = JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'f1' }] });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(1 + DEFAULT_SERVER_TOOLS.length);
    expect(parsed.tools[0].name).toBe('f1');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:datetime');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_search');
    expect(parsed.tools.map((t: { type: string }) => t.type)).toContain('openrouter:web_fetch');
  });

  it('forwards a caller-supplied tool config (with options) verbatim', () => {
    const custom = [{ type: 'openrouter:web_search', engine: 'exa', max_results: 5 }];
    const hooks = createServerToolsHooks(custom);
    const body = JSON.stringify({ model: 'test', tools: [] });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toEqual(custom);
  });

  it('appends nothing when given an empty tool list', () => {
    const hooks = createServerToolsHooks([]);
    const body = JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'f1' }] });
    const input = { url: new URL('https://example.com'), options: { body } };

    const result = hooks.beforeCreateRequest(
      {} as Parameters<typeof hooks.beforeCreateRequest>[0],
      input,
    );

    const parsed = JSON.parse((result as { options: { body: string } }).options.body);
    expect(parsed.tools).toHaveLength(1);
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
    expect(parsed.tools).toHaveLength(DEFAULT_SERVER_TOOLS.length);
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

  it('attaches the HTTP status as a structured statusCode property on a 500', async () => {
    // The transient-retry classifier in agent.ts reads a numeric `statusCode`
    // off the thrown error (or one `cause` hop, covering the SDK's
    // UnexpectedClientError wrap). Message-text-only errors defeat it — the
    // 2026-06-10/11 incident shape where HTTP-level 500s never retried.
    const body = JSON.stringify({ error: { message: 'Internal Server Error' } });
    const response = new Response(body, { status: 500, statusText: 'Internal Server Error' });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error & { statusCode?: number }).statusCode).toBe(500);
    // The message still carries the extracted body detail.
    const msg = (result.error as Error).message;
    expect(msg).toContain('OpenRouter request failed (500)');
    expect(msg).toContain('Internal Server Error');
  });

  it('attaches statusCode on 4xx errors too (classifier treats them as non-transient)', async () => {
    const response = new Response('', { status: 402, statusText: 'Payment Required' });
    const result = await callAfterError(response, null);
    expect((result.error as Error & { statusCode?: number }).statusCode).toBe(402);
  });

  it('attaches statusCode 0 when no response object is available', async () => {
    const result = await callAfterError(null, null);
    expect((result.error as Error & { statusCode?: number }).statusCode).toBe(0);
  });

  it('error message includes the HTTP status code', async () => {
    const body = JSON.stringify({ error: { message: 'over quota' } });
    const response = new Response(body, { status: 429, statusText: 'Too Many Requests' });
    const result = await callAfterError(response, null);
    expect((result.error as Error).message).toMatch(/429/);
    expect((result.error as Error).message).toContain('over quota');
  });

  async function messageFor(payload: unknown, status = 500): Promise<string> {
    const response = new Response(JSON.stringify(payload), {
      status,
      statusText: 'Internal Server Error',
    });
    const result = await callAfterError(response, null);
    expect(result.error).toBeInstanceOf(Error);
    return (result.error as Error).message;
  }

  it('appends provider_name and raw upstream error from error.metadata', async () => {
    const msg = await messageFor({
      error: {
        message: 'Provider returned error',
        metadata: { provider_name: 'Kluster', raw: 'error code: 1015' },
      },
    });
    expect(msg).toBe(
      'OpenRouter request failed (500): Provider returned error [provider=Kluster, raw=error code: 1015]',
    );
  });

  it('JSON-stringifies a non-string raw metadata value', async () => {
    const msg = await messageFor({
      error: {
        message: 'Provider returned error',
        metadata: { provider_name: 'openai', raw: { code: 500, detail: 'upstream exploded' } },
      },
    });
    expect(msg).toContain('[provider=openai, raw={"code":500,"detail":"upstream exploded"}]');
  });

  it('truncates an oversized raw metadata value at 500 chars', async () => {
    const msg = await messageFor({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'r'.repeat(800) },
      },
    });
    expect(msg).toContain(`[raw=${'r'.repeat(500)}…[truncated]]`);
  });

  it('renders provider_name alone when raw is absent or null', async () => {
    expect(
      await messageFor({
        error: { message: 'failed', metadata: { provider_name: 'Anthropic', raw: null } },
      }),
    ).toContain('failed [provider=Anthropic]');
  });

  it('omits the metadata suffix when metadata is absent, non-object, or empty', async () => {
    expect(await messageFor({ error: { message: 'plain' } })).toBe(
      'OpenRouter request failed (500): plain',
    );
    expect(await messageFor({ error: { message: 'plain', metadata: 'nope' } })).toBe(
      'OpenRouter request failed (500): plain',
    );
    expect(
      await messageFor({ error: { message: 'plain', metadata: { provider_name: '', raw: '' } } }),
    ).toBe('OpenRouter request failed (500): plain');
  });

  it('does not append metadata when no message could be extracted', async () => {
    // metadata present but neither error.message nor top-level message —
    // `extracted` stays undefined, so the raw body is used verbatim.
    const payload = { error: { metadata: { provider_name: 'openai' } } };
    const msg = await messageFor(payload);
    expect(msg).toBe(`OpenRouter request failed (500): ${JSON.stringify(payload)}`);
  });
});
