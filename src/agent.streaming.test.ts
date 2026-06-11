import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

// The mock state, threaded through both the StateAccessor (which the agent
// owns) and the fake callModel mock (which inspects state to simulate the
// SDK's interrupt polling). One-shot reset in beforeEach.
let memoryStates = new Map<string, unknown>();

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
  const isToolCallOutputEvent = (
    e: unknown,
  ): e is {
    type: 'tool.call_output';
    output: { callId: string; output: unknown; status?: string };
  } => !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
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

// Replace the file-backed state accessor with an in-memory one so the fake
// callModel mock can read / write state synchronously without filesystem
// timing. The map key is sessionId — one entry per run.
vi.mock('./state/file-state.js', () => ({
  createFileStateAccessor: (_logsRoot: string, sessionId: string) => ({
    load: async () => memoryStates.get(sessionId) ?? null,
    save: async (s: unknown) => {
      memoryStates.set(sessionId, s);
    },
  }),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { AgentCoreEvent } from './events.js';
import type { UserInput } from './streaming-input.js';

interface FakeResponse {
  id?: string;
  model?: string;
  usage?: { cost?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  output?: unknown[];
}

/**
 * Build a fake callModel that runs a script of "call cycles". Each script
 * entry describes one callModel invocation:
 *
 * - `events`: array yielded from getFullResponsesStream()
 * - `response`: response returned by getResponse()
 * - `onBeforeReturn`: optional sync side effect that runs right before the
 *   stream's `return` (used to simulate the SDK persisting status='interrupted'
 *   into state — the agent loads state after the cycle ends and pivots
 *   accordingly).
 */
interface CycleScript {
  events: unknown[];
  response?: FakeResponse;
  onBeforeReturn?: (sessionId: string) => void;
  /** Whether to invoke onTurnEnd at the end (true → cost from `response.usage.cost` counts). */
  invokeOnTurnEnd?: boolean;
}

function scriptCallModel(scripts: readonly CycleScript[]): void {
  let i = 0;
  callModelMock.mockImplementation(
    (request: {
      sessionId: string;
      onTurnEnd?: (ctx: unknown, resp: FakeResponse) => Promise<void> | void;
    }) => {
      const script = scripts[i] ?? scripts[scripts.length - 1];
      i++;
      const response: FakeResponse = script.response ?? {
        id: `resp-${i}`,
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        output: [],
      };
      return {
        async *getFullResponsesStream() {
          for (const ev of script.events) yield ev;
          if (script.onBeforeReturn) script.onBeforeReturn(request.sessionId);
          if (script.invokeOnTurnEnd && request.onTurnEnd) {
            await request.onTurnEnd({}, response);
          }
        },
        async getResponse() {
          return response;
        },
        async cancel() {
          return;
        },
      };
    },
  );
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  memoryStates = new Map<string, unknown>();
});

const TEST_SESSION = 'test-streaming-session';

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('OpenRouterAgentRun — AsyncIterable prompt', () => {
  it('runs one callModel cycle per yielded UserInput and ends after iter signals done', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'first response' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        response: {
          id: 'r1',
          model: 'm',
          usage: { cost: 0.01, inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          output: [],
        },
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'second response' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        response: {
          id: 'r2',
          model: 'm',
          usage: { cost: 0.02, inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          output: [],
        },
      },
    ]);

    async function* prompt(): AsyncGenerator<UserInput> {
      yield { content: 'one' };
      yield { content: 'two' };
    }

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: prompt(),
    });
    const events = await collect(run);

    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(callModelMock.mock.calls[0][0].input).toEqual([{ role: 'user', content: 'one' }]);
    expect(callModelMock.mock.calls[1][0].input).toEqual([{ role: 'user', content: 'two' }]);

    const textDeltas = events
      .filter((e): e is Extract<AgentCoreEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.content);
    expect(textDeltas).toEqual(['first response', 'second response']);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
    expect(complete.usage?.totalTokens).toBe(10);
  });

  it('ends cleanly with one stream_complete when the AsyncIterable yields no values', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    async function* empty(): AsyncGenerator<UserInput> {
      // yield nothing
    }
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: empty(),
    });
    const events = await collect(run);

    expect(callModelMock).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['session_started', 'stream_complete']);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('rejects a prompt that is neither a string nor an AsyncIterable at construction time', () => {
    expect(
      () =>
        new OpenRouterAgentRun({
          apiKey: 'sk-test',
          sessionId: TEST_SESSION,
          // @ts-expect-error — testing the runtime guard
          prompt: 42,
        }),
    ).toThrow(/streaming input/i);
  });
});

describe('OpenRouterAgentRun — pushUserMessage', () => {
  it('queues follow-up messages that drive subsequent callModel cycles after a string prompt', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'second' },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'first',
    });
    void run.pushUserMessage('then this');

    const events = await collect(run);
    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(callModelMock.mock.calls[0][0].input).toEqual([{ role: 'user', content: 'first' }]);
    expect(callModelMock.mock.calls[1][0].input).toEqual([{ role: 'user', content: 'then this' }]);

    const textDeltas = events
      .filter((e): e is Extract<AgentCoreEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.content);
    expect(textDeltas).toEqual(['second']);
  });

  it('queue takes precedence over a concurrent AsyncIterable yield', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    async function* iter(): AsyncGenerator<UserInput> {
      yield { content: 'iter1' };
      yield { content: 'iter2' };
    }

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: iter(),
    });
    // Push before iteration starts — queue lands first.
    void run.pushUserMessage('pushed');
    await collect(run);

    const inputs = callModelMock.mock.calls.map(
      (c) => (c[0] as { input: Array<{ content: string }> }).input[0].content,
    );
    // Order should be: pushed → iter1 → iter2.
    expect(inputs).toEqual(['pushed', 'iter1', 'iter2']);
  });
});

describe('OpenRouterAgentRun — interrupt + restart', () => {
  it('commits partialResponse text as an assistant message and resumes on next user message', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'half-finis' },
        ],
        // Simulate the SDK's checkForInterruption: write
        // status='interrupted' + partialResponse, then return from the stream.
        onBeforeReturn: (sessionId) => {
          memoryStates.set(sessionId, {
            id: sessionId,
            messages: [{ type: 'message', role: 'user', content: 'first' }],
            status: 'interrupted',
            interruptedBy: 'host-interrupt',
            partialResponse: { text: 'half-finished assistant reply' },
            createdAt: 1,
            updatedAt: 2,
          });
        },
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'recovery' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        // Second cycle ends normally — clear interrupt state.
        onBeforeReturn: (sessionId) => {
          const cur = memoryStates.get(sessionId) as Record<string, unknown> | undefined;
          if (cur) {
            memoryStates.set(sessionId, {
              ...cur,
              status: 'complete',
              interruptedBy: undefined,
            });
          }
        },
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'first',
    });
    // Schedule a second user push so the loop restarts after the interrupt.
    void run.pushUserMessage('follow up');

    const events = await collect(run);
    expect(callModelMock).toHaveBeenCalledTimes(2);

    // Between cycle 1 and 2, the agent commits partialResponse.text into
    // messages and clears the field. Inspect the state after the run.
    const finalState = memoryStates.get(TEST_SESSION) as {
      messages: Array<{ role: string; content: unknown }>;
      partialResponse?: unknown;
    };
    expect(finalState).toBeDefined();
    // The committed assistant message should be present in history.
    const assistantMessages = finalState.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe('half-finished assistant reply');
    expect(finalState.partialResponse).toBeUndefined();

    // The interrupt was reported on the trailing stream_complete? Only if
    // the LAST cycle was interrupted — here the last cycle completed
    // cleanly, so `reason` should be absent.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    expect(complete.reason).toBeUndefined();
  });

  it('synthesises a turn_end event on interrupt so the rich message stream flushes', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'mid-thought' },
        ],
        onBeforeReturn: (sessionId) => {
          memoryStates.set(sessionId, {
            id: sessionId,
            messages: [{ type: 'message', role: 'user', content: 'q' }],
            status: 'interrupted',
            interruptedBy: 'host-interrupt',
            partialResponse: { text: 'mid-thought' },
            createdAt: 1,
            updatedAt: 2,
          });
        },
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'q',
    });
    const events = await collect(run);

    // Synthetic turn_end fired between text_delta and stream_complete because
    // the SDK never emitted one.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'turn_start',
      'text_delta',
      'turn_end',
      'stream_complete',
    ]);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    // Interrupt was the LAST event before termination → reason carried.
    expect(complete.reason).toBe('host-interrupt');
  });

  it('interrupt() writes the flag via the state accessor and is idempotent before iteration', async () => {
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'q',
    });
    await run.interrupt();
    await run.interrupt();
    const state = memoryStates.get(TEST_SESSION) as { interruptedBy?: string } | undefined;
    expect(state?.interruptedBy).toBe('host-interrupt');
  });

  it('logs a warning when commitPartialResponse throws between cycles but continues the run', async () => {
    // Cycle 1 ends interrupted. Make the state accessor throw on load
    // ONCE (during commit). The agent should warn and keep going.
    let loadsBeforeCycle2Pull = 0;
    const failingAccessor = {
      load: vi.fn(async () => {
        const cur = memoryStates.get(TEST_SESSION) ?? null;
        // The first load after cycle 1 ends is the `stateStatus === 'interrupted'`
        // detection — let that through. The NEXT load is from
        // commitPartialResponse at the top of cycle 2 — make it throw once.
        loadsBeforeCycle2Pull++;
        if (loadsBeforeCycle2Pull === 2) {
          throw new Error('synthetic load failure');
        }
        return cur;
      }),
      save: vi.fn(async (s: unknown) => {
        memoryStates.set(TEST_SESSION, s);
      }),
    };
    // Override the mocked file accessor for THIS test by re-mocking the
    // import once. Simplest: stash the original implementation and reach
    // into the module-level mock. Since we already mock the factory above,
    // grab a fresh handle via vi.doMock won't take effect post-import. So
    // we patch the run's stateAccessor directly via reflection.
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'partial' },
        ],
        onBeforeReturn: (sessionId) => {
          memoryStates.set(sessionId, {
            id: sessionId,
            messages: [{ type: 'message', role: 'user', content: 'q' }],
            status: 'interrupted',
            interruptedBy: 'host-interrupt',
            partialResponse: { text: 'partial' },
            createdAt: 1,
            updatedAt: 2,
          });
        },
      },
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    const logs: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'q',
      logger: (level, message) => {
        logs.push({ level, message });
      },
    });
    // Patch the private stateAccessor with the failing one.
    (run as unknown as { stateAccessor: unknown }).stateAccessor = failingAccessor;
    void run.pushUserMessage('after');
    const events = await collect(run);

    expect(logs.some((l) => l.message.includes('Failed to commit partial response'))).toBe(true);
    // The run still completes.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
  });

  it('interrupt() awaits the in-flight cycle and lets the loop restart cleanly', async () => {
    // Cycle 1 yields a delta and blocks until released. Cycle 2 is a clean
    // success. interrupt() is called between cycles via pushUserMessage,
    // and we verify it resolves only after the in-flight stream unwinds.
    let releaseCycle1: () => void = () => undefined;
    const cycle1Ready = new Promise<void>((res) => {
      releaseCycle1 = res;
    });
    let signalCycle1Blocked: () => void = () => undefined;
    const cycle1Blocked = new Promise<void>((res) => {
      signalCycle1Blocked = res;
    });

    let i = 0;
    callModelMock.mockImplementation((request: { sessionId: string }) => {
      i++;
      if (i === 1) {
        return {
          async *getFullResponsesStream(): AsyncGenerator<unknown> {
            yield { type: 'turn.start', turnNumber: 0 };
            yield { type: 'response.output_text.delta', delta: 'streaming' };
            signalCycle1Blocked();
            await cycle1Ready;
            // After release, write interrupted state and return.
            memoryStates.set(request.sessionId, {
              id: request.sessionId,
              messages: [{ type: 'message', role: 'user', content: 'q' }],
              status: 'interrupted',
              interruptedBy: 'host-interrupt',
              partialResponse: { text: 'streaming' },
              createdAt: 1,
              updatedAt: 2,
            });
          },
          async getResponse() {
            return { id: 'r1', model: 'm', usage: { cost: 0 }, output: [] };
          },
          async cancel() {
            return;
          },
        };
      }
      return {
        async *getFullResponsesStream(): AsyncGenerator<unknown> {
          yield { type: 'turn.start', turnNumber: 0 };
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return { id: 'r2', model: 'm', usage: { cost: 0 }, output: [] };
        },
        async cancel() {
          return;
        },
      };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'q',
    });
    void run.pushUserMessage('after-interrupt');

    // Start consuming the run; first cycle is now in-flight (will block).
    const eventsP = collect(run);

    // Deterministic: wait until cycle 1's generator has reached `await cycle1Ready`.
    await cycle1Blocked;

    // interrupt() should not resolve until cycle 1 unwinds.
    let interruptResolved = false;
    const interruptP = run.interrupt().then(() => {
      interruptResolved = true;
    });
    // Flush microtasks + pending I/O callbacks. Since cycle 1 is genuinely
    // blocked on `cycle1Ready` (only released below), interrupt() — which
    // awaits the cycle's completion — cannot resolve while we drain here.
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(interruptResolved).toBe(false);

    // Release cycle 1 → it writes interrupted state and returns.
    releaseCycle1();
    await interruptP;
    expect(interruptResolved).toBe(true);

    const events = await eventsP;
    // Two cycles ran: the interrupted one + the recovery one.
    expect(callModelMock).toHaveBeenCalledTimes(2);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });
});

describe('OpenRouterAgentRun — image attachments', () => {
  it('forwards UserInput.content as a ContentBlock[] verbatim to callModel.input', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    const blocks = [
      { type: 'input_text', text: 'describe this' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'auto' },
    ];
    async function* prompt(): AsyncGenerator<UserInput> {
      yield { content: blocks };
    }

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: prompt(),
    });
    await collect(run);

    expect(callModelMock).toHaveBeenCalledTimes(1);
    const sentInput = callModelMock.mock.calls[0][0].input;
    expect(sentInput).toEqual([{ role: 'user', content: blocks }]);
    // Same reference identity — no defensive copy / mutation along the way.
    expect(sentInput[0].content).toBe(blocks);
  });
});

describe('OpenRouterAgentRun — reasoning deltas', () => {
  it('yields reasoning_delta core events for response.reasoning_text.delta, skipping empty deltas', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          // Shape mirrors the vendored SDK's ReasoningDeltaEvent.
          {
            type: 'response.reasoning_text.delta',
            delta: 'let me ',
            itemId: 'rs_1',
            contentIndex: 0,
            outputIndex: 0,
            sequenceNumber: 1,
          },
          // Empty delta — must be skipped (parity with text_delta).
          {
            type: 'response.reasoning_text.delta',
            delta: '',
            itemId: 'rs_1',
            contentIndex: 0,
            outputIndex: 0,
            sequenceNumber: 2,
          },
          {
            type: 'response.reasoning_text.delta',
            delta: 'think',
            itemId: 'rs_1',
            contentIndex: 0,
            outputIndex: 0,
            sequenceNumber: 3,
          },
          { type: 'response.output_text.delta', delta: 'the answer' },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'reason it out',
    });
    const events = await collect(run);

    const sequence = events
      .filter(
        (e): e is Extract<AgentCoreEvent, { type: 'reasoning_delta' | 'text_delta' }> =>
          e.type === 'reasoning_delta' || e.type === 'text_delta',
      )
      .map((e) => [e.type, e.content]);
    // Two reasoning deltas (empty one dropped) arrive BEFORE the text delta,
    // preserving wire order.
    expect(sequence).toEqual([
      ['reasoning_delta', 'let me '],
      ['reasoning_delta', 'think'],
      ['text_delta', 'the answer'],
    ]);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('drops reasoning deltas after abort (same post-abort filter as text deltas)', async () => {
    const controller = new AbortController();
    callModelMock.mockImplementation(() => ({
      async *getFullResponsesStream(): AsyncGenerator<unknown> {
        yield { type: 'turn.start', turnNumber: 0 };
        yield {
          type: 'response.reasoning_text.delta',
          delta: 'pre-abort thought',
          itemId: 'rs_1',
          contentIndex: 0,
          outputIndex: 0,
          sequenceNumber: 1,
        };
        controller.abort();
        yield {
          type: 'response.reasoning_text.delta',
          delta: 'post-abort thought',
          itemId: 'rs_1',
          contentIndex: 0,
          outputIndex: 0,
          sequenceNumber: 2,
        };
      },
      async getResponse() {
        return { id: 'r', model: 'm', usage: { cost: 0 }, output: [] };
      },
      async cancel() {
        return;
      },
    }));

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'q',
      signal: controller.signal,
    });
    const events = await collect(run);

    const reasoning = events
      .filter(
        (e): e is Extract<AgentCoreEvent, { type: 'reasoning_delta' }> =>
          e.type === 'reasoning_delta',
      )
      .map((e) => e.content);
    expect(reasoning).toEqual(['pre-abort thought']);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.reason).toBe('aborted');
  });
});

describe('OpenRouterAgentRun — back-compat with string prompt', () => {
  it('still runs exactly one callModel cycle when prompt is a plain string and no pushes happen', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'response.output_text.delta', delta: 'one-shot' },
          { type: 'turn.end', turnNumber: 0 },
        ],
        response: {
          id: 'r',
          model: 'm',
          usage: { cost: 0.005, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [],
        },
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'just one',
    });
    const events = await collect(run);
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(callModelMock.mock.calls[0][0].input).toEqual([{ role: 'user', content: 'just one' }]);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });
});

describe('OpenRouterAgentRun — server tools', () => {
  it('emits a server_tool event for openrouter:* output items, alongside client tool_call', async () => {
    scriptCallModel([
      {
        events: [
          { type: 'turn.start', turnNumber: 0 },
          // A client function_call still maps to tool_call (unchanged).
          {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 'c1',
              name: 'read_file',
              arguments: '{"path":"x"}',
            },
          },
          // An OpenRouter server tool maps to server_tool.
          {
            type: 'response.output_item.done',
            outputIndex: 1,
            sequenceNumber: 2,
            item: {
              type: 'openrouter:datetime',
              id: 'st_dt',
              status: 'completed',
              datetime: '2026-06-11T12:00:00Z',
              timezone: 'UTC',
            },
          },
          { type: 'turn.end', turnNumber: 0 },
        ],
      },
    ]);

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'what time is it',
    });
    const events = await collect(run);

    const toolCall = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(toolCall).toMatchObject({ callId: 'c1', name: 'read_file', input: { path: 'x' } });

    const serverTool = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'server_tool' }> => e.type === 'server_tool',
    );
    expect(serverTool).toBeDefined();
    expect(serverTool!.toolType).toBe('openrouter:datetime');
    expect(serverTool!.callId).toBe('st_dt');
    expect(serverTool!.status).toBe('completed');
    expect(serverTool!.isError).toBe(false);
    expect(serverTool!.output).toEqual({ datetime: '2026-06-11T12:00:00Z', timezone: 'UTC' });
  });
});
