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
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { AgentCoreEvent } from './events.js';

/**
 * Simulates the published `@openrouter/agent` SDK bug: when a follow-up turn
 * sees a `response.failed` event, `pipeAndConsumeStream` throws WITHOUT
 * completing its broadcaster, and the surrounding `executeToolsIfNeeded`
 * IIFE has no `.catch()`. The rejection ends up on `this.toolExecutionPromise`
 * (returned by `getResponse()`) and — unless observed — surfaces as an
 * unhandled promise rejection.
 */
function fakeCallModelWithOrphanedRejection(events: unknown[]) {
  return () => {
    const rejected = Promise.reject(new Error('Response failed'));
    return {
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        for (const ev of events) yield ev;
      },
      getResponse: () => rejected,
    };
  };
}

describe('agent — drains orphaned getResponse rejection', () => {
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

  it('does not leak an unhandled rejection when the stream surfaces response.failed', async () => {
    callModelMock.mockImplementation(
      fakeCallModelWithOrphanedRejection([
        { type: 'turn.start', turnNumber: 0, timestamp: 1 },
        {
          type: 'response.failed',
          sequenceNumber: 1,
          response: { error: { code: 'server_error', message: 'upstream exploded' } },
        },
      ]),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sess-unhandled-rejection',
      prompt: 'fail please',
      persistSession: false,
      tools: [] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      // Pin the single-attempt terminal-unwind path — the retry loop has its
      // own drain coverage in agent.transient-retry.test.ts.
      maxTransientRetries: 0,
    });

    const collected: AgentCoreEvent[] = [];
    for await (const e of run) collected.push(e);

    const complete = collected.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('server_error: upstream exploded');

    // Give the microtask queue + one macrotask tick a chance to let any
    // orphaned rejection bubble up to the process handler before asserting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(observed).toEqual([]);
  });
});
