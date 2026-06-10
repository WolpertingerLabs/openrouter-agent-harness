import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

/**
 * Mirrors the real `@openrouter/agent` `ModelResult.startTurnBroadcasterExecution`
 * shape: ONE underlying `toolExecutionPromise` (returned from `getResponse()`)
 * plus a SEPARATE `.finally(...)` chained promise (`executionPromise`) that the
 * SDK generator awaits AFTER its inner for-await loop drains.
 *
 * If the harness throws eagerly on `response.failed`, the generator is closed
 * via `iter.return()` BEFORE reaching `await executionPromise`, orphaning the
 * chained promise. Node surfaces it as `unhandledRejection`, crashing the host
 * (callboard's daemon, in the reported incident).
 *
 * If the harness captures the event and continues, the generator's
 * `await executionPromise` observes the rejection naturally and rethrows into
 * the harness's for-await, where the outer catch handles it cleanly.
 */
function fakeCallModelWithChainedRejection(
  events: unknown[],
  postYieldChainedPromise: () => Promise<unknown>,
  toolExecutionPromise: Promise<unknown>,
) {
  return () => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      for (const ev of events) yield ev;
      // This mirrors model-result.js:1586: `await executionPromise;` runs only
      // after the inner consumer loop drains. If the outer for-await closes us
      // early (via iter.return()), this line never executes and the chained
      // promise becomes orphaned.
      await postYieldChainedPromise();
    },
    // Mirrors model-result.js:1555 — `getResponse()` awaits the cached
    // `toolExecutionPromise`, NOT the `.finally()`-chained `executionPromise`.
    getResponse: () => toolExecutionPromise,
  });
}

describe('agent — no orphaned chained-promise rejection on response.failed', () => {
  let observed: Array<{ reason: unknown }> = [];
  const handler = (reason: unknown): void => {
    observed.push({ reason });
  };

  beforeEach(() => {
    callModelMock.mockReset();
    openRouterCtorMock.mockReset();
    observed = [];
    process.on('unhandledRejection', handler);
  });

  afterEach(() => {
    process.off('unhandledRejection', handler);
  });

  async function flushMicrotasks(): Promise<void> {
    // A couple of macrotask hops give Node's unhandledRejection detection
    // (which runs at the end of a tick) time to fire if a promise is orphaned.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it('does not leak an unhandled rejection when the chained executionPromise rejects mid-stream', async () => {
    // toolExecutionPromise — what `getResponse()` returns (model-result.js:1555).
    const toolExecutionPromise: Promise<unknown> = Promise.reject(
      new Error('Response failed: {"code":"server_error","message":"Internal Server Error"}'),
    );
    // executionPromise — the `.finally()` chain returned by
    // startTurnBroadcasterExecution. Separate object. Observed only by the
    // SDK generator's `await executionPromise;` line.
    const executionPromise: Promise<unknown> = toolExecutionPromise.finally(() => undefined);

    callModelMock.mockImplementation(
      fakeCallModelWithChainedRejection(
        [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          {
            type: 'response.failed',
            sequenceNumber: 1,
            response: {
              error: { code: 'server_error', message: 'Internal Server Error' },
            },
          },
        ],
        () => executionPromise,
        toolExecutionPromise,
      ),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sess-chained-promise',
      prompt: 'fail please',
      persistSession: false,
      tools: [] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      // This suite pins the terminal-unwind drain path — disable the
      // transient-failure retry loop so the `server_error`-coded event fails
      // in one attempt (the retry-path drain is covered by
      // agent.transient-retry.test.ts).
      maxTransientRetries: 0,
    });

    const collected: AgentCoreEvent[] = [];
    for await (const e of run) collected.push(e);

    // The terminal event must be a stream_complete with the pretty-printed
    // reason derived from the captured `response.failed` event — NOT the
    // SDK's ugly JSON-stringified envelope. Confirms the catch arm consults
    // `pendingFailedEvent` rather than `err.message`.
    const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('server_error: Internal Server Error');

    // The error event should also carry the pretty form.
    const errorEvent = collected.find((e) => e.type === 'error') as Extract<
      AgentCoreEvent,
      { type: 'error' }
    >;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe('server_error: Internal Server Error');

    // Critical assertion: no orphaned rejection from the chained
    // executionPromise. Pre-fix, the harness threw eagerly on response.failed,
    // closing the SDK generator before `await executionPromise` ran — that
    // line was the only observer of the chained promise's rejection, so Node
    // logged unhandledRejection and exited the host process.
    await flushMicrotasks();
    expect(observed).toEqual([]);
  });

  it('handles a follow-up-turn response.failed the same way (pipeAndConsumeStream path)', async () => {
    // Simulates a successful first turn (turn.start / turn.end), then a
    // response.failed on the follow-up. The SDK's `pipeAndConsumeStream`
    // path produces the same chained-promise shape as the initial-turn case.
    const toolExecutionPromise: Promise<unknown> = Promise.reject(
      new Error('Response failed: {"code":"server_error","message":"upstream exploded"}'),
    );
    const executionPromise: Promise<unknown> = toolExecutionPromise.finally(() => undefined);

    callModelMock.mockImplementation(
      fakeCallModelWithChainedRejection(
        [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
          { type: 'turn.start', turnNumber: 1, timestamp: 3 },
          {
            type: 'response.failed',
            sequenceNumber: 99,
            response: {
              error: { code: 'server_error', message: 'upstream exploded' },
            },
          },
        ],
        () => executionPromise,
        toolExecutionPromise,
      ),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sess-chained-promise-followup',
      prompt: 'fail on follow-up',
      persistSession: false,
      tools: [] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      // See the maxTransientRetries note on the previous test.
      maxTransientRetries: 0,
    });

    const collected: AgentCoreEvent[] = [];
    for await (const e of run) collected.push(e);

    const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('server_error: upstream exploded');

    await flushMicrotasks();
    expect(observed).toEqual([]);
  });
});
