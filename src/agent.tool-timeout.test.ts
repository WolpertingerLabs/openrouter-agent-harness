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
import type { AgentCoreEvent, HookEvent, HookPayload } from './events.js';
import type { Tool } from '@openrouter/agent';

const start = { type: 'turn.start', turnNumber: 1, timestamp: 1 };

/**
 * Fake callModel that executes ONE tool from the run's wrapped tool array
 * (mirroring the SDK's `executeRegularTool`: a thrown execute is caught and
 * JSON-wrapped as `{"error": <message>}` in a normal `function_call_output`),
 * then completes the turn.
 */
function toolCyclingAttempt(toolName: string, input: unknown = {}) {
  return (args: {
    tools?: Array<{ function: { name: string; execute?: (i: unknown, c?: unknown) => unknown } }>;
  }) => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      yield start;
      const tool = args.tools!.find((t) => t.function.name === toolName)!;
      let output: string;
      try {
        const result = await tool.function.execute!(input, { toolCall: { callId: 'c1' } });
        output = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      yield {
        type: 'tool.call_output',
        timestamp: 0,
        output: { callId: 'c1', type: 'function_call_output', output, status: 'completed' },
      };
      yield {
        type: 'response.completed',
        sequenceNumber: 2,
        response: { id: 'r', model: 'm', output: [], usage: { cost: 0 } },
      };
      yield { type: 'turn.end', turnNumber: 1, timestamp: 2 };
    },
    async getResponse() {
      return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
    },
  });
}

/** Client tool whose execute sleeps `delayMs`, then resolves (or rejects). */
function slowTool(name: string, delayMs: number, opts: { rejects?: boolean } = {}): Tool {
  return {
    type: 'function',
    function: {
      name,
      description: 'deliberately slow',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        if (opts.rejects) throw new Error('late failure');
        return { ok: true };
      },
    },
  } as unknown as Tool;
}

type RunOptions = ConstructorParameters<typeof OpenRouterAgentRun>[0];

function makeRun(extra: Partial<RunOptions> = {}): OpenRouterAgentRun {
  return new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: 'sess-tool-timeout',
    prompt: 'time the tools',
    persistSession: false,
    ...extra,
  });
}

async function collect(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const events: AgentCoreEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

function toolResultOf(events: AgentCoreEvent[]): Extract<AgentCoreEvent, { type: 'tool_result' }> {
  const result = events.find(
    (e): e is Extract<AgentCoreEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  expect(result).toBeDefined();
  return result!;
}

function completeOf(
  events: AgentCoreEvent[],
): Extract<AgentCoreEvent, { type: 'stream_complete' }> {
  const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
  expect(complete.type).toBe('stream_complete');
  return complete;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toolTimeoutMs — per-tool execute deadline', () => {
  it('times a slow non-exempt tool out at the default 60s; the result is an isError JSON envelope and the run continues', async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // The tool eventually REJECTS (at t=300s, long after the deadline) —
      // exercising the orphaned-promise catch-drain.
      callModelMock.mockImplementationOnce(toolCyclingAttempt('slow_custom'));
      const eventsP = collect(
        makeRun({ tools: [slowTool('slow_custom', 300_000, { rejects: true })] }),
      );
      await vi.advanceTimersByTimeAsync(60_000); // deadline fires
      const events = await eventsP;

      expect(completeOf(events).status).toBe('success'); // run continued
      const result = toolResultOf(events);
      expect(result.isError).toBe(true);
      // SDK envelope: {"error": <thrown message>}; the thrown message is our
      // JSON shape — parse twice to reach the machine-checkable marker.
      const envelope = JSON.parse(result.output as string) as { error: string };
      const inner = JSON.parse(envelope.error) as { error: string; timedOut: boolean };
      expect(inner.timedOut).toBe(true);
      expect(inner.error).toBe('tool slow_custom timed out after 60000ms');

      // The losing execute settles (rejected) much later — swallowed.
      await vi.advanceTimersByTimeAsync(240_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('PostToolUse reflects the timeout error (deadline composes INSIDE the hook wrapper)', async () => {
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    callModelMock.mockImplementationOnce(toolCyclingAttempt('slow_custom'));
    const eventsP = collect(
      makeRun({
        tools: [slowTool('slow_custom', 300_000)],
        toolTimeoutMs: 1_000,
        onHook: (event, payload) => {
          hookEvents.push({ event, payload });
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    const post = hookEvents.find((h) => h.event === 'PostToolUse')!.payload as Extract<
      HookPayload,
      { event: 'PostToolUse' }
    >;
    expect(post.isError).toBe(true);
    expect(post.output).toContain('"timedOut":true');
    // Drain the orphaned execute timer so it doesn't leak into other tests.
    await vi.advanceTimersByTimeAsync(300_000);
  });

  it.each([
    ['bash (own timeout_ms)', 'bash'],
    ['spawn_subagent (long-running by design)', 'spawn_subagent'],
    ['spawn_subagents (long-running by design)', 'spawn_subagents'],
    ['ask_user_question (blocks on a human answering)', 'ask_user_question'],
    ['monitor (own max_duration_ms)', 'monitor'],
    ['skill (fork-context skills run a subagent inside execute)', 'skill'],
    ['MCP-bridged names with the __ separator', 'srv__remote_thing'],
  ])('exempts %s from the deadline', async (_label, name) => {
    callModelMock.mockImplementationOnce(toolCyclingAttempt(name));
    // Deadline of 1s; the tool takes 90s and must still complete normally.
    const eventsP = collect(makeRun({ tools: [slowTool(name, 90_000)], toolTimeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(90_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    const result = toolResultOf(events);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output as string)).toEqual({ ok: true });
  });

  it('toolTimeoutMs: 0 disables the deadline entirely', async () => {
    callModelMock.mockImplementationOnce(toolCyclingAttempt('slow_custom'));
    const eventsP = collect(
      makeRun({ tools: [slowTool('slow_custom', 90_000)], toolTimeoutMs: 0 }),
    );
    await vi.advanceTimersByTimeAsync(90_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    expect(toolResultOf(events).isError).toBe(false);
  });

  it('a fast tool resolves well inside the deadline (timer cleared, no late rejection)', async () => {
    callModelMock.mockImplementationOnce(toolCyclingAttempt('quick'));
    const eventsP = collect(makeRun({ tools: [slowTool('quick', 1_000)], toolTimeoutMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await eventsP;

    expect(completeOf(events).status).toBe('success');
    expect(toolResultOf(events).isError).toBe(false);
    // Run past the would-be deadline: the cleared timer must not fire.
    await vi.advanceTimersByTimeAsync(120_000);
  });

  it('passes server tools and execute-less tool forms through untouched', async () => {
    // Neither shape has a client-side execute to wrap — the timeout and
    // activity-tracker wrappers must both pass them through, and the run
    // must complete normally with them in the pool.
    const serverTool = { _brand: 'server-tool', name: 'openrouter_web_search' } as unknown as Tool;
    const executeLess = {
      type: 'function',
      function: { name: 'manual_tool', description: 'no local execute', parameters: {} },
    } as unknown as Tool;
    callModelMock.mockImplementationOnce(() => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield start;
        yield {
          type: 'response.completed',
          sequenceNumber: 2,
          response: { id: 'r', model: 'm', output: [], usage: { cost: 0 } },
        };
        yield { type: 'turn.end', turnNumber: 1, timestamp: 2 };
      },
      async getResponse() {
        return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
      },
    }));

    const events = await collect(makeRun({ tools: [serverTool, executeLess] }));
    expect(completeOf(events).status).toBe('success');
    // The pool forwarded to callModel still contains both, unwrapped.
    const sentTools = (callModelMock.mock.calls[0]![0] as { tools: Tool[] }).tools;
    expect(sentTools).toHaveLength(2);
    expect(sentTools[0]).toBe(serverTool);
    expect(sentTools[1]).toBe(executeLess);
  });
});
