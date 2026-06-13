import { describe, it, expect, vi, beforeEach } from 'vitest';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const stepCountIs = (n: number) => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number) => ({ kind: 'maxCost', n });
  const isTurnStartEvent = (e: unknown): e is { type: 'turn.start'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.start';
  const isTurnEndEvent = (e: unknown): e is { type: 'turn.end'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.end';
  const isToolCallOutputEvent = (e: unknown): boolean =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
  class OpenRouter {
    callModel: typeof callModelMock;
    constructor(...args: unknown[]) {
      openRouterCtorMock(...args);
      this.callModel = callModelMock;
    }
  }
  return {
    ...actual,
    OpenRouter,
    stepCountIs,
    maxCost,
    isTurnStartEvent,
    isTurnEndEvent,
    isToolCallOutputEvent,
  };
});

vi.mock('./tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { AgentLogger } from './agent.js';
import type { AgentCoreEvent } from './events.js';

function fakeCallModel(events: unknown[]) {
  return () => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      for (const ev of events) yield ev;
    },
    async getResponse() {
      return { id: 'r', model: 'm', output: [] };
    },
  });
}

async function runFor(events: unknown[], logger?: AgentLogger): Promise<AgentCoreEvent[]> {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  callModelMock.mockImplementation(fakeCallModel(events));
  const run = new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: 'sess-response-failed',
    prompt: 'fail please',
    persistSession: false,
    tools: [] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
    // This suite tests reason EXTRACTION only — disable the transient-failure
    // retry loop so `server_error`-coded events fail in one attempt instead
    // of burning the default 2 retries + backoff (covered by
    // agent.transient-retry.test.ts).
    maxTransientRetries: 0,
    ...(logger && { logger }),
  });
  const collected: AgentCoreEvent[] = [];
  for await (const e of run) collected.push(e);
  const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
  expect(complete.type).toBe('stream_complete');
  expect(complete.status).toBe('error');
  return collected;
}

async function reasonFor(events: unknown[]): Promise<string | undefined> {
  const collected = await runFor(events);
  const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
  return complete.reason;
}

function errorEventOf(collected: AgentCoreEvent[]): Extract<AgentCoreEvent, { type: 'error' }> {
  const ev = collected.find((e) => e.type === 'error');
  expect(ev).toBeDefined();
  return ev as Extract<AgentCoreEvent, { type: 'error' }>;
}

const start = { type: 'turn.start', turnNumber: 0, timestamp: 1 };

describe('response.failed reason extraction', () => {
  beforeEach(() => {
    callModelMock.mockReset();
    openRouterCtorMock.mockReset();
  });

  it('prefixes the error code when both code and message are present', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: { code: 'server_error', message: 'upstream exploded' } },
      },
    ]);
    expect(reason).toBe('server_error: upstream exploded');
  });

  it('uses the bare error message when no code is present', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: { message: 'just a message' } },
      },
    ]);
    expect(reason).toBe('just a message');
  });

  it('falls back to a top-level event.message when response.error is absent', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        message: 'top-level message',
        response: { error: null },
      },
    ]);
    expect(reason).toBe('top-level message');
  });

  it('falls back to response.incompleteDetails.reason when no error/message text exists', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: null, incompleteDetails: { reason: 'content_filter' } },
      },
    ]);
    expect(reason).toBe('content_filter');
  });

  it('falls back to a generic label when nothing usable is present', async () => {
    const reason = await reasonFor([
      start,
      { type: 'response.failed', sequenceNumber: 1, response: {} },
    ]);
    expect(reason).toBe('Response failed');
  });

  it('treats a null/non-object response as having no detail', async () => {
    const reason = await reasonFor([
      start,
      { type: 'response.failed', sequenceNumber: 1, message: 'top-level', response: null },
    ]);
    expect(reason).toBe('top-level');
    const reason2 = await reasonFor([
      start,
      { type: 'response.failed', sequenceNumber: 1, message: 'top-level', response: 'nope' },
    ]);
    expect(reason2).toBe('top-level');
  });
});

describe('response.failed detail extraction', () => {
  beforeEach(() => {
    callModelMock.mockReset();
    openRouterCtorMock.mockReset();
  });

  const failedError = { code: 'server_error', message: 'Internal Server Error' };

  it('appends response id, model, attempts, and routing summary to the reason', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: {
          id: 'resp_abc123',
          model: 'openai/gpt-5.4',
          error: failedError,
          openrouterMetadata: {
            summary: 'all endpoints failed',
            requested: 'openai/gpt-5.4',
            region: 'us-east',
            attempts: [
              { model: 'openai/gpt-5.4', provider: 'openai', status: 500 },
              { model: 'openai/gpt-5.4', provider: 'azure', status: 502 },
            ],
          },
        },
      },
    ]);
    expect(reason).toBe(
      'server_error: Internal Server Error (resp_abc123 openai/gpt-5.4; attempts: openai→500, azure→502; all endpoints failed)',
    );
  });

  it('appends the suffix to the fallback reason paths too', async () => {
    const detailResponse = { id: 'resp_x', error: null };
    expect(
      await reasonFor([
        start,
        { type: 'response.failed', sequenceNumber: 1, message: 'top', response: detailResponse },
      ]),
    ).toBe('top (resp_x)');
    expect(
      await reasonFor([
        start,
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: { id: 'resp_x', error: null, incompleteDetails: { reason: 'content_filter' } },
        },
      ]),
    ).toBe('content_filter (resp_x)');
    expect(
      await reasonFor([
        start,
        { type: 'response.failed', sequenceNumber: 1, response: { id: 'resp_x' } },
      ]),
    ).toBe('Response failed (resp_x)');
  });

  it('caps rendered attempts at 5 and marks missing provider/status with ?', async () => {
    const attempts = Array.from({ length: 7 }, (_, i) => ({ provider: `p${i}`, status: 500 + i }));
    attempts[1] = { status: 501 } as (typeof attempts)[number];
    attempts[2] = { provider: 'p2' } as (typeof attempts)[number];
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: failedError, openrouterMetadata: { attempts } },
      },
    ]);
    expect(reason).toBe(
      'server_error: Internal Server Error (attempts: p0→500, ?→501, p2→?, p3→503, p4→504, +2 more)',
    );
  });

  it('truncates a long routing summary in the suffix', async () => {
    const reason = await reasonFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: failedError, openrouterMetadata: { summary: 'x'.repeat(250) } },
      },
    ]);
    expect(reason).toBe(`server_error: Internal Server Error (${'x'.repeat(200)}…[truncated])`);
  });

  it('ignores malformed metadata fields and empty/invalid attempts entries', async () => {
    // Wrong types everywhere → no detail at all, reason unchanged.
    expect(
      await reasonFor([
        start,
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: {
            id: 42,
            model: ['not', 'a', 'string'],
            error: failedError,
            openrouterMetadata: 'not-an-object',
          },
        },
      ]),
    ).toBe('server_error: Internal Server Error');
    // Metadata present but every field malformed; attempts entries that are
    // null, primitives, or carry no recognized keys are skipped entirely.
    expect(
      await reasonFor([
        start,
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: {
            error: failedError,
            openrouterMetadata: {
              summary: 99,
              requested: null,
              region: undefined,
              attempts: [null, 'bogus', { unrelated: true }, { status: 'not-a-number' }],
            },
          },
        },
      ]),
    ).toBe('server_error: Internal Server Error');
    // null metadata object.
    expect(
      await reasonFor([
        start,
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: { error: failedError, openrouterMetadata: null },
        },
      ]),
    ).toBe('server_error: Internal Server Error');
  });

  it('keeps the suffix empty when detail has no renderable parts (requested/region only)', async () => {
    // `requested`/`region` ride on the structured detail but are not rendered
    // into the one-line suffix; empty-string id/model/summary are filtered.
    const collected = await runFor([
      start,
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: {
          id: '',
          model: '',
          error: failedError,
          openrouterMetadata: { requested: 'openai/gpt-5.4', region: 'eu-west', summary: '' },
        },
      },
    ]);
    const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.reason).toBe('server_error: Internal Server Error');
    expect(errorEventOf(collected).detail).toEqual({
      responseId: '',
      model: '',
      requested: 'openai/gpt-5.4',
      region: 'eu-west',
      routingSummary: '',
    });
  });

  it('exposes structured detail on the error event and in logger fields', async () => {
    const logged: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const failedEvent = {
      type: 'response.failed',
      sequenceNumber: 1,
      response: {
        id: 'resp_abc',
        model: 'openai/gpt-5.4',
        error: failedError,
        openrouterMetadata: {
          summary: 'provider 500',
          attempts: [{ model: 'openai/gpt-5.4', provider: 'openai', status: 500 }],
        },
      },
    };
    const collected = await runFor([start, failedEvent], (level, message, fields) => {
      logged.push({ level, message, ...(fields && { fields }) });
    });
    const expectedDetail = {
      responseId: 'resp_abc',
      model: 'openai/gpt-5.4',
      routingSummary: 'provider 500',
      attempts: [{ model: 'openai/gpt-5.4', provider: 'openai', status: 500 }],
    };
    expect(errorEventOf(collected).detail).toEqual(expectedDetail);
    const errLog = logged.find((l) => l.message === 'OpenRouterAgentRun stream errored');
    expect(errLog).toBeDefined();
    expect(errLog!.fields!.detail).toEqual(expectedDetail);
    expect(errLog!.fields!.failedEvent).toBe(JSON.stringify(failedEvent));
  });

  it('truncates the serialized failed event in logger fields at 4000 chars', async () => {
    const logged: Record<string, unknown>[] = [];
    await runFor(
      [
        start,
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: { error: { code: 'server_error', message: 'm'.repeat(5000) } },
        },
      ],
      (_level, message, fields) => {
        if (message === 'OpenRouterAgentRun stream errored') logged.push(fields!);
      },
    );
    const serialized = logged[0].failedEvent as string;
    expect(serialized.endsWith('…[truncated]')).toBe(true);
    expect(serialized.length).toBe(4000 + '…[truncated]'.length);
  });

  it('serializes unstringifiable failed events without throwing', async () => {
    const logged: Record<string, unknown>[] = [];
    // Circular reference → JSON.stringify throws → String(value) fallback.
    const circular: {
      type: string;
      sequenceNumber: number;
      response: Record<string, unknown>;
      self?: unknown;
    } = {
      type: 'response.failed',
      sequenceNumber: 1,
      response: { error: { code: 'server_error', message: 'boom' } },
    };
    circular.self = circular;
    await runFor([start, circular], (_level, message, fields) => {
      if (message === 'OpenRouterAgentRun stream errored') logged.push(fields!);
    });
    expect(logged[0].failedEvent).toBe('[object Object]');

    // toJSON returning undefined → JSON.stringify returns undefined → String fallback.
    logged.length = 0;
    const undef = {
      type: 'response.failed',
      sequenceNumber: 1,
      response: { error: { code: 'server_error', message: 'boom' } },
      toJSON: () => undefined,
    };
    await runFor([start, undef], (_level, message, fields) => {
      if (message === 'OpenRouterAgentRun stream errored') logged.push(fields!);
    });
    expect(logged[0].failedEvent).toBe('[object Object]');
  });
});
