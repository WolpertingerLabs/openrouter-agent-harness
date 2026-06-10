/**
 * Regression tests for the silent-hang bug where an OpenRouter API error
 * (e.g. a 402 "insufficient credits") causes the agent run to hang forever
 * when server tools are enabled (disableServerTools: false).
 *
 * Root cause: the SDK's default afterError hook returns {response, error:null}
 * on non-2xx responses, which in certain code paths inside ModelResult causes
 * getFullResponsesStream() to close without emitting any events or throwing.
 * The agent's for-await loop then exits silently — no error event, no
 * stream_complete.
 *
 * Fix 1 (server-tools.ts): register an afterError hook that converts a
 * non-2xx Response with no existing Error into a thrown Error, forcing the
 * SDK to propagate the failure.
 *
 * Fix 2 (agent.ts): after the for-await loop exits, if no response.completed
 * was observed AND the signal is not aborted, await result.getResponse() in a
 * try/catch and surface any rejection as an error.
 *
 * Both modes (disableServerTools: true and false) must yield
 * stream_complete{status:"error"} with the API error message in `reason`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @openrouter/agent so we can simulate API-error scenarios without a
// live network connection.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mock server-tools: we test both "tools enabled" and "tools disabled" paths.
// The mock is deliberately thin — it still exports a real SDKHooks-shaped
// object so the OpenRouter constructor receives a truthy `hooks` value when
// server tools are on, mirroring production.
// ---------------------------------------------------------------------------
vi.mock('./tools/server-tools.js', () => ({
  SERVER_TOOLS: [
    { type: 'openrouter:datetime' },
    { type: 'openrouter:web_search' },
    { type: 'openrouter:web_fetch' },
  ],
  // When server tools are "enabled" we return an object with a recognisable
  // marker so tests can inspect which hooks were passed to OpenRouter.
  createServerToolsHooks: () => ({ __serverToolsHooks: true }),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { AgentCoreEvent } from './events.js';

// ---------------------------------------------------------------------------
// callModel factory helpers
// ---------------------------------------------------------------------------

/**
 * Simulates a getFullResponsesStream() that yields no events and a
 * getResponse() that THROWS — the scenario produced when the SDK's
 * afterError hook is properly wired and converts a 4xx into an Error
 * that propagates out of ModelResult.
 *
 * This represents Fix 1 working correctly: afterError throws, initStream
 * rejects, and getFullResponsesStream() re-throws at `await this.initStream()`.
 */
function makeThrowingCallModel(errorMessage: string) {
  return () => ({
    cancel: async () => undefined,
    // eslint-disable-next-line require-yield -- throwing before any yield is the point
    async *getFullResponsesStream(): AsyncGenerator<unknown> {
      throw new Error(errorMessage);
    },
    async getResponse() {
      throw new Error(errorMessage);
    },
  });
}

/**
 * Simulates the *silent-hang* scenario: getFullResponsesStream() yields zero
 * events and exits cleanly (no throw), but getResponse() REJECTS with the
 * real API error. This is the state before Fix 1 (afterError not wired): the
 * SDK swallows the 4xx in afterError, initStream appears to succeed, the SSE
 * stream is either empty or never sends response.completed, and the broadcaster
 * closes without error.
 *
 * Fix 2 in agent.ts detects "no response.completed observed" and calls
 * result.getResponse() to surface the pending rejection.
 */
function makeSilentStreamCallModel(errorMessage: string) {
  return () => ({
    cancel: async () => undefined,
    async *getFullResponsesStream(): AsyncGenerator<unknown> {
      // Yields nothing — simulates broadcaster.complete() with no events.
    },
    async getResponse() {
      throw new Error(errorMessage);
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const events: AgentCoreEvent[] = [];
  for await (const ev of run) events.push(ev);
  return events;
}

function makeRun(overrides: { disableServerTools?: boolean } = {}): OpenRouterAgentRun {
  return new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: `sess-api-error-${Date.now()}`,
    prompt: 'hi',
    persistSession: false,
    disableServerTools: overrides.disableServerTools,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

describe('API error propagation — Fix 1 (afterError hook throws)', () => {
  const apiErrorMsg =
    'OpenRouter request failed (402): This request requires more credits, or fewer max_tokens. ' +
    'You requested up to 65536 tokens, but can only afford 62298.';

  it('yields stream_complete{status:"error"} when disableServerTools: true', async () => {
    callModelMock.mockImplementation(makeThrowingCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: true }));

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('can only afford 62298');
  });

  it('yields stream_complete{status:"error"} when disableServerTools: false', async () => {
    callModelMock.mockImplementation(makeThrowingCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('can only afford 62298');
  });

  it('yields an error event before stream_complete', async () => {
    callModelMock.mockImplementation(makeThrowingCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const errorEvent = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain('can only afford 62298');
  });

  it('always yields session_started before the error event', async () => {
    callModelMock.mockImplementation(makeThrowingCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(types).toContain('error');
    expect(types.at(-1)).toBe('stream_complete');
  });
});

describe('API error propagation — Fix 2 (defense-in-depth: silent stream + getResponse throws)', () => {
  const apiErrorMsg =
    'OpenRouter request failed (402): This request requires more credits, or fewer max_tokens. ' +
    'You requested up to 65536 tokens, but can only afford 62298.';

  it('yields stream_complete{status:"error"} when disableServerTools: false and stream exits silently', async () => {
    // This is the exact pre-fix hang scenario:
    // - getFullResponsesStream() exits with no events (no throw)
    // - getResponse() rejects with the real API error
    callModelMock.mockImplementation(makeSilentStreamCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('can only afford 62298');
  });

  it('yields stream_complete{status:"error"} when disableServerTools: true and stream exits silently', async () => {
    callModelMock.mockImplementation(makeSilentStreamCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: true }));

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('can only afford 62298');
  });

  it('yields an error event before stream_complete in the silent-stream path', async () => {
    callModelMock.mockImplementation(makeSilentStreamCallModel(apiErrorMsg));
    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const errorEvent = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain('can only afford 62298');
  });

  it('does NOT call getResponse() when response.completed was already seen (happy path guard)', async () => {
    // When a cycle completes normally, the defense-in-depth check must NOT
    // call getResponse() a second time (which would be a no-op but is wasteful).
    const getResponseSpy = vi.fn().mockResolvedValue({
      id: 'r1',
      model: 'mock',
      usage: { cost: 0, inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      output: [],
    });
    callModelMock.mockImplementation(() => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield { type: 'turn.start', turnNumber: 0, timestamp: 1 };
        yield { type: 'response.completed', response: { model: 'm', output: [], usage: null } };
        yield { type: 'turn.end', turnNumber: 0, timestamp: 2 };
      },
      getResponse: getResponseSpy,
    }));

    const events = await collectEvents(makeRun({ disableServerTools: false }));

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    // getResponse is called once by the agent's post-loop logic (line
    // `const response = await result.getResponse()`), NOT an extra time from
    // the defense-in-depth path.
    expect(getResponseSpy).toHaveBeenCalledTimes(1);
  });
});
