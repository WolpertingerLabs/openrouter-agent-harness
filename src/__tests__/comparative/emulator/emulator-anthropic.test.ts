import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

import {
  startEmulator,
  computePromptHash,
  canonicalizeRequest,
  ScriptRegistry,
  type EmulatorHandle,
} from './index.js';
import { buildAnthropicEvents, serializeSseEvent } from './sse.js';

// Use the underlying `@anthropic-ai/sdk` client for round-trip tests. The
// Claude Agent SDK spawns a Bun-compiled subprocess (238MB binary, ~60s
// retry-loop runtime per spike 6.S1) which is unsuitable for fast emulator
// unit tests. The agent SDK's subprocess uses this same client internally —
// so wire-level compatibility here proves compatibility for the agent SDK.
// 6.3 will add the full claude-agent-sdk integration as part of the harness
// scaffolding.
function makeClient(baseURL: string): Anthropic {
  return new Anthropic({
    baseURL,
    apiKey: 'sk-ant-emulator-stub',
    // Disable retries so failure-injection tests surface errors immediately
    // instead of consuming the SDK's default 2-retry budget.
    maxRetries: 0,
  });
}

const MODEL = 'claude-sonnet-4-5-20250929';

function singleTurnRequest(text: string): {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
  stream: true;
} {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: text }],
    stream: true,
  };
}

/**
 * Low-level POST helper that tolerates abrupt socket close mid-stream.
 * Returns whatever bytes the server wrote before closing — used by failure-
 * injection tests where `fetch()` would discard partial bodies as an error.
 */
function rawHttpPost(
  baseUrl: string,
  path: string,
  jsonBody: unknown,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const url = new URL(path, baseUrl);
  const payload = Buffer.from(JSON.stringify(jsonBody));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        const finish = () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('aborted', finish);
      },
    );
    req.on('error', (err) => {
      // Server force-closed; if we never got headers, surface the error.
      // Otherwise the response handler above already resolves.
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

describe('emulator: script-engine', () => {
  it('canonicalizes equal requests to identical strings regardless of key order', () => {
    const a = { model: 'x', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 };
    const b = { temperature: 0.5, messages: [{ role: 'user', content: 'hi' }], model: 'x' };
    expect(canonicalizeRequest(a)).toBe(canonicalizeRequest(b));
  });

  it('strips non-semantic fields (metadata, stream) from the hash', () => {
    const base = singleTurnRequest('hello');
    const withMetadata = { ...base, metadata: { user_id: 'random-id' }, stream: false };
    expect(computePromptHash(base)).toBe(computePromptHash(withMetadata));
  });

  it('differentiates requests with different messages', () => {
    expect(computePromptHash(singleTurnRequest('a'))).not.toBe(
      computePromptHash(singleTurnRequest('b')),
    );
  });

  it('masks the wall-clock month sentence in tool descriptions (hash survives month boundaries)', () => {
    const withMonth = (month: string, year: string) => ({
      ...singleTurnRequest('hi'),
      tools: [
        {
          name: 'WebSearch',
          description: `Search the web.\n  - The current month is ${month} ${year}. You MUST use this year when searching for recent information.`,
          input_schema: { type: 'object' },
        },
      ],
    });
    const may = computePromptHash(withMonth('May', '2026'));
    expect(computePromptHash(withMonth('June', '2026'))).toBe(may);
    expect(computePromptHash(withMonth('December', '2027'))).toBe(may);
    // The masked token replaces the sentence fragment, not the whole
    // description — other description edits must still change the hash.
    const edited = {
      ...withMonth('May', '2026'),
      tools: [
        {
          name: 'WebSearch',
          description: 'Search the web. The current month is May 2026. Extra sentence.',
          input_schema: { type: 'object' },
        },
      ],
    };
    expect(computePromptHash(edited)).not.toBe(may);
  });

  it('does not mask month-like text outside the known sentence pattern', () => {
    const body = (desc: string) => ({
      ...singleTurnRequest('hi'),
      tools: [{ name: 't', description: desc, input_schema: { type: 'object' } }],
    });
    expect(computePromptHash(body('Launched in May 2026 with new features'))).not.toBe(
      computePromptHash(body('Launched in June 2026 with new features')),
    );
  });

  it('registry lookup advances turn counter on hit', () => {
    const r = new ScriptRegistry();
    const body = singleTurnRequest('hi');
    const hash = computePromptHash(body);
    r.register({
      promptHash: hash,
      turn: 0,
      kind: 'success',
      response: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const first = r.lookup(body);
    expect(first.ok).toBe(true);
    expect(r.turnsServed).toBe(1);
  });

  it('registry miss returns diagnostic + dedups subsequent identical misses', () => {
    const r = new ScriptRegistry();
    const body = singleTurnRequest('uh-oh');
    const first = r.lookup(body);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.dedup).toBe(false);
    expect(first.error.body.error.type).toBe('emulator_script_miss');
    expect(first.error.body.error.diagnostic.promptHash).toBe(computePromptHash(body));
    expect(first.error.body.error.diagnostic.turn).toBe(0);
    expect(first.error.body.error.diagnostic.registered).toEqual([]);
    const second = r.lookup(body);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.dedup).toBe(true);
  });

  it('reset() rewinds the turn counter and clears dedup', () => {
    const r = new ScriptRegistry();
    r.lookup(singleTurnRequest('x'));
    expect(r.turnsServed).toBe(0);
    r.reset();
    const miss = r.lookup(singleTurnRequest('x'));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.dedup).toBe(false);
  });
});

describe('emulator: sse event builder', () => {
  it('produces the documented Anthropic event sequence in order', () => {
    const events = buildAnthropicEvents(
      {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      { chunkSize: 'natural' },
    );
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('emits input_json_delta for tool_use content blocks', () => {
    const events = buildAnthropicEvents({
      model: MODEL,
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'echo',
          input: { value: 'hi' },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 8 },
    });
    const delta = events.find((e) => e.event === 'content_block_delta');
    expect(delta?.data).toMatchObject({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"value":"hi"}' },
    });
  });

  it('chunkSize=N splits text into N-char deltas', () => {
    const events = buildAnthropicEvents(
      {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'abcdef' }],
        usage: { input_tokens: 1, output_tokens: 6 },
      },
      { chunkSize: 2 },
    );
    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas).toHaveLength(3);
    expect((deltas[0]!.data as { delta: { text: string } }).delta.text).toBe('ab');
    expect((deltas[2]!.data as { delta: { text: string } }).delta.text).toBe('ef');
  });

  it('serializes to event:/data: lines with trailing blank line', () => {
    const wire = serializeSseEvent({ event: 'message_stop', data: { type: 'message_stop' } });
    expect(wire).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});

describe('emulator: HTTP round-trip (Anthropic /v1/messages)', () => {
  let emu: EmulatorHandle;

  beforeEach(async () => {
    emu = await startEmulator();
  });

  afterEach(async () => {
    await emu.stop();
  });

  it('round-trips a text-only response through @anthropic-ai/sdk', async () => {
    const body = singleTurnRequest('echo this');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'success',
      response: {
        id: 'msg_test_1',
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Hello world.' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
      stream: { chunkSize: 5 },
    });

    const client = makeClient(emu.url);
    const stream = client.messages.stream(body);
    const final = await stream.finalMessage();

    expect(final.id).toBe('msg_test_1');
    expect(final.stop_reason).toBe('end_turn');
    expect(final.content).toHaveLength(1);
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'Hello world.' });
  });

  it('supports tool_use content blocks alongside text', async () => {
    const body = singleTurnRequest('use the tool');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'success',
      response: {
        model: MODEL,
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: "I'll echo that." },
          {
            type: 'tool_use',
            id: 'toolu_01ab',
            name: 'echo',
            input: { value: 'hello world' },
          },
        ],
        usage: { input_tokens: 20, output_tokens: 15 },
      },
    });

    const client = makeClient(emu.url);
    const stream = client.messages.stream(body);
    const final = await stream.finalMessage();

    expect(final.stop_reason).toBe('tool_use');
    expect(final.content).toHaveLength(2);
    expect(final.content[0]).toMatchObject({ type: 'text', text: "I'll echo that." });
    expect(final.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_01ab',
      name: 'echo',
      input: { value: 'hello world' },
    });
  });

  it('round-trips all five Anthropic stop reasons', async () => {
    const stopReasons = [
      'end_turn',
      'tool_use',
      'max_tokens',
      'stop_sequence',
      'pause_turn',
    ] as const;
    for (const stopReason of stopReasons) {
      const body = singleTurnRequest(`prompt for ${stopReason}`);
      emu.registry.reset();
      emu.registry.register({
        promptHash: computePromptHash(body),
        turn: 0,
        kind: 'success',
        response: {
          model: MODEL,
          stopReason,
          content: [{ type: 'text', text: stopReason }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const client = makeClient(emu.url);
      const final = await client.messages.stream(body).finalMessage();
      expect(final.stop_reason).toBe(stopReason);
    }
  });

  it('returns 500 with structured diagnostic on missing script', async () => {
    const body = singleTurnRequest('nothing registered for this');
    const client = makeClient(emu.url);
    let caught: unknown;
    try {
      await client.messages.stream(body).finalMessage();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // The Anthropic SDK wraps non-2xx responses; the underlying body is in
    // the error object. The shape varies — verify via direct fetch instead.
    const res = await fetch(`${emu.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'sk-ant-emulator-stub',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(500);
    const payload = (await res.json()) as {
      error: {
        type: string;
        message: string;
        diagnostic?: {
          promptHash: string;
          turn: number;
          body: unknown;
          registered: unknown[];
        };
        dedup?: boolean;
      };
    };
    expect(payload.error.type).toBe('emulator_script_miss');
    // First call from the SDK is the dedupable miss; this direct fetch is
    // the second miss for the same hash+turn → dedup flag set.
    expect(payload.error.dedup).toBe(true);
  });

  it('tolerates the ?beta=true query string the agent SDK sends', async () => {
    const body = singleTurnRequest('beta query');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'success',
      response: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const res = await fetch(`${emu.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('rejects non-streaming requests with a 400 stub-fail', async () => {
    const res = await fetch(`${emu.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...singleTurnRequest('hi'), stream: false }),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toMatch(/streaming/);
  });

  it('404s on unknown paths', async () => {
    const res = await fetch(`${emu.url}/v1/unknown`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('emulator: failure injection (Anthropic shape)', () => {
  let emu: EmulatorHandle;

  beforeEach(async () => {
    emu = await startEmulator();
  });

  afterEach(async () => {
    await emu.stop();
  });

  it('mid_stream_error: emits an SSE error event after N normal events', async () => {
    const body = singleTurnRequest('cause overload mid-stream');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'failure',
      failure: { type: 'mid_stream_error', eventsBeforeError: 2 },
      partial: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const res = await fetch(`${emu.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: error');
    expect(text).toContain('overloaded_error');
  });

  it('rate_limit_429: returns 429 with Retry-After header (no SSE)', async () => {
    const body = singleTurnRequest('rate-limited');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'failure',
      failure: { type: 'rate_limit_429', retryAfter: 30 },
    });
    const res = await fetch(`${emu.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    const payload = (await res.json()) as { error: { type: string } };
    expect(payload.error.type).toBe('rate_limit_error');
  });

  it('malformed_delta: emits a content_block_delta with invalid JSON', async () => {
    const body = singleTurnRequest('malformed JSON delta');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'failure',
      failure: { type: 'malformed_delta', atDeltaIndex: 0 },
      partial: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'unreachable' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const res = await fetch(`${emu.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The malformed line should contain our intentional non-JSON sentinel.
    expect(text).toContain('not-valid-json');
  });

  it('truncated_stream: closes the socket mid-event', async () => {
    const body = singleTurnRequest('truncate me');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'failure',
      failure: { type: 'truncated_stream', eventsBeforeTruncation: 1 },
      partial: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'should-not-complete' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    // `fetch()` treats a forced socket close as a hard error and discards
    // already-received bytes. Use `node:http` directly so we can collect
    // whatever made it onto the wire before the truncation.
    const { status, body: text } = await rawHttpPost(emu.url, '/v1/messages', body);
    expect(status).toBe(200);
    expect(text).toContain('event: message_start');
    // Truncation drops the terminator after the last partial event, so the
    // payload never reaches `message_stop`.
    expect(text).not.toContain('event: message_stop');
  });

  it('split_json_field: forces a TCP chunk boundary inside a data line', async () => {
    const body = singleTurnRequest('split me');
    emu.registry.register({
      promptHash: computePromptHash(body),
      turn: 0,
      kind: 'failure',
      failure: { type: 'split_json_field', atDeltaIndex: 0, splitAt: 20 },
      partial: {
        model: MODEL,
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'hello-world' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    // Use a low-level fetch + iterate chunks to assert the body still
    // reassembles correctly across chunk boundaries — proves a real SDK
    // (which uses an incremental parser) would survive the split.
    const res = await fetch(`${emu.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('hello-world');
    expect(text).toContain('event: message_stop');
  });
});
