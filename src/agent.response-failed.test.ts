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
  SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
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

async function reasonFor(events: unknown[]): Promise<string | undefined> {
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
  });
  const collected: AgentCoreEvent[] = [];
  for await (const e of run) collected.push(e);
  const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
  expect(complete.type).toBe('stream_complete');
  expect(complete.status).toBe('error');
  return complete.reason;
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
});
