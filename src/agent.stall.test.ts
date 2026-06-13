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
import type { AgentLoggerLevel } from './agent.js';
import type { AgentCoreEvent } from './events.js';
import type { StateAccessor, Tool } from '@openrouter/agent';

const start = { type: 'turn.start', turnNumber: 1, timestamp: 1 };

function completedEvent(cost: number) {
  return {
    type: 'response.completed',
    sequenceNumber: 2,
    response: {
      id: 'r',
      model: 'm',
      // A realistic successful response carries assistant content — a blank
      // output would trip the empty-response net and retry the cycle.
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { cost },
    },
  };
}

interface CallModelArgs {
  input: unknown[];
  state: StateAccessor;
  tools?: Array<{ function: { name: string; execute?: (i: unknown, c?: unknown) => unknown } }>;
}

/** Mirror of the SDK's `saveResponseToState` semantics (see
 * agent.transient-retry.test.ts for the full rationale). */
async function persistLikeSdk(args: CallModelArgs): Promise<void> {
  const prior = (await args.state.load())?.messages;
  const messages = [
    ...(Array.isArray(prior) ? prior : []),
    ...args.input,
    { type: 'message', role: 'assistant', content: 'ok' },
  ];
  await args.state.save({ messages } as never);
}

/**
 * Attempt whose SSE stream yields one turn.start then goes permanently
 * silent — the real shape of a dead upstream connection (no error, no
 * close, no further events). `cancel()` resolves immediately; the hung
 * generator itself never unblocks (mirroring an SDK generator parked on a
 * read that will never complete), which is exactly why the stall teardown
 * must not await the closed iterator.
 */
function hangingAttempt() {
  return (_args: CallModelArgs) => ({
    cancel: vi.fn(async () => undefined),
    async *getFullResponsesStream() {
      yield start;
      await new Promise<never>(() => undefined);
    },
    async getResponse(): Promise<unknown> {
      throw new Error('stream never completed');
    },
  });
}

/** Attempt that completes one response, persisting like the SDK does. */
function successfulAttempt(cost = 0) {
  return (args: CallModelArgs) => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      yield start;
      await persistLikeSdk(args);
      yield completedEvent(cost);
    },
    async getResponse() {
      return { id: 'r', model: 'm', output: [], usage: { cost } };
    },
  });
}

type RunOptions = ConstructorParameters<typeof OpenRouterAgentRun>[0];

let logs: Array<{ level: AgentLoggerLevel; message: string; context?: unknown }> = [];

function makeRun(extra: Partial<RunOptions> = {}): OpenRouterAgentRun {
  return new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: 'sess-stall',
    prompt: 'stall me',
    persistSession: false,
    tools: [] as unknown as RunOptions['tools'],
    transientRetryBaseDelayMs: 0,
    logger: (level, message, context) => {
      logs.push({ level, message, context });
    },
    ...extra,
  });
}

async function collect(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const events: AgentCoreEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

function completeOf(
  events: AgentCoreEvent[],
): Extract<AgentCoreEvent, { type: 'stream_complete' }> {
  const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
  expect(complete.type).toBe('stream_complete');
  return complete;
}

function retryWarnings(): Array<{ level: AgentLoggerLevel; message: string; context?: unknown }> {
  return logs.filter((l) => l.level === 'warn' && l.message.includes('retrying cycle'));
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  logs = [];
  // setImmediate stays real so unhandled-rejection flushes work; setTimeout
  // and Date are faked so the 120s default stall window is testable.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streamStallTimeoutMs — stall detection and retry', () => {
  it('a stalled stream trips the watchdog, transient-retries, and the second attempt succeeds', async () => {
    const cancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    callModelMock
      .mockImplementationOnce((args: CallModelArgs) => {
        const attempt = hangingAttempt()(args);
        cancelSpies.push(attempt.cancel);
        return attempt;
      })
      .mockImplementationOnce(successfulAttempt());

    const eventsP = collect(makeRun()); // default streamStallTimeoutMs = 120_000
    // turn.start arrives at t≈0 (fake clock — no time passes between arm and
    // bump), so when the timer fires at t=120_000 the activity is exactly one
    // full window old and the stall fires on the first check.
    await vi.advanceTimersByTimeAsync(120_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // The dead stream was torn down via cancel().
    expect(cancelSpies[0]).toHaveBeenCalled();
    // One warn-level retry log whose reason is the stall message.
    const warns = retryWarnings();
    expect(warns).toHaveLength(1);
    expect((warns[0]!.context as { reason: string }).reason).toMatch(
      /stream stalled: no events received for 120000ms/,
    );
  });

  it('re-arms for the remainder when events flowed before the silence (stall lands one window after the LAST event)', async () => {
    callModelMock
      .mockImplementationOnce((args: CallModelArgs) => ({
        cancel: async () => undefined,
        async *getFullResponsesStream() {
          yield start;
          // Healthy traffic for a while…
          await new Promise((r) => setTimeout(r, 90_000));
          yield { type: 'response.output_text.delta', delta: 'still alive' };
          // …then the connection dies.
          await new Promise<never>(() => undefined);
          void args;
        },
        async getResponse(): Promise<unknown> {
          throw new Error('stream never completed');
        },
      }))
      .mockImplementationOnce(successfulAttempt());

    const eventsP = collect(makeRun());
    // t=120_000: first timer fire — last activity was t=90_000 (30s ago), so
    // the watchdog re-arms for the 90s remainder instead of firing.
    await vi.advanceTimersByTimeAsync(180_000);
    const eventsSoFar = retryWarnings();
    expect(eventsSoFar).toHaveLength(0); // t=180_000 < 90_000 + 120_000
    await vi.advanceTimersByTimeAsync(30_000); // t=210_000 = last activity + window
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    expect(events.some((e) => e.type === 'text_delta' && e.content === 'still alive')).toBe(true);
    expect(retryWarnings()).toHaveLength(1);
  });

  it('surfaces error + stream_complete{status:error} with the stall reason when retries are exhausted', async () => {
    callModelMock.mockImplementation(hangingAttempt());

    const eventsP = collect(makeRun({ maxTransientRetries: 1 }));
    // First attempt stalls at 120s; retry stalls again 120s later.
    await vi.advanceTimersByTimeAsync(240_000);
    const events = await eventsP;

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toMatch(/stream stalled: no events received for 120000ms/);
    const errorEvent = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent?.message).toMatch(/stream stalled/);
    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(retryWarnings()).toHaveLength(1);
  });

  it('does NOT stall while a long client tool execution silences the stream', async () => {
    const slowTool: Tool = {
      type: 'function',
      function: {
        name: 'slow_tool',
        description: 'sleeps well past the stall window',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          // 300s of silence — 2.5 stall windows — all legitimately excused.
          await new Promise((r) => setTimeout(r, 300_000));
          return { ok: true };
        },
      },
    } as unknown as Tool;

    callModelMock.mockImplementationOnce((args: CallModelArgs) => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield start;
        const tool = args.tools!.find((t) => t.function.name === 'slow_tool')!;
        const out = await tool.function.execute!({}, { toolCall: { callId: 'c1' } });
        yield {
          type: 'tool.call_output',
          timestamp: 0,
          output: {
            callId: 'c1',
            type: 'function_call_output',
            output: JSON.stringify(out),
            status: 'completed',
          },
        };
        await persistLikeSdk(args);
        yield completedEvent(0);
        yield { type: 'turn.end', turnNumber: 1, timestamp: 2 };
      },
      async getResponse() {
        return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
      },
    }));

    // toolTimeoutMs: 0 — this test isolates stall suspension from the
    // per-tool deadline (which would otherwise fire at 60s).
    const eventsP = collect(makeRun({ tools: [slowTool], toolTimeoutMs: 0 }));
    await vi.advanceTimersByTimeAsync(300_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(retryWarnings()).toHaveLength(0);
    const toolResult = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(toolResult?.isError).toBe(false);
  });

  it('streamStallTimeoutMs: 0 disables the watchdog entirely', async () => {
    let releaseHang: () => void = () => undefined;
    callModelMock.mockImplementationOnce((_args: CallModelArgs) => ({
      cancel: async () => {
        // Cancellation is what ends the dead stream in this scenario —
        // mirroring the SDK closing the SSE iterator on cancel().
        releaseHang();
      },
      async *getFullResponsesStream() {
        yield start;
        await new Promise<void>((r) => {
          releaseHang = r;
        });
      },
      getResponse: () => new Promise<never>(() => undefined),
    }));

    const controller = new AbortController();
    const eventsP = collect(makeRun({ streamStallTimeoutMs: 0, signal: controller.signal }));
    let settled = false;
    void eventsP.then(() => {
      settled = true;
    });
    // Five default windows of pure silence — with the watchdog disabled the
    // run just keeps waiting.
    await vi.advanceTimersByTimeAsync(600_000);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(retryWarnings()).toHaveLength(0);

    // Unwind via abort so the test exits cleanly.
    controller.abort();
    const events = await eventsP;
    expect(completeOf(events).reason).toBe('aborted');
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });
});
