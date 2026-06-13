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
import type { AgentLoggerLevel } from './agent.js';
import type { AgentCoreEvent } from './events.js';
import type { StateAccessor } from '@openrouter/agent';

const start = { type: 'turn.start', turnNumber: 1, timestamp: 1 };

const TEXT_OUTPUT = [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }];

function completedEvent(output: unknown[], sequenceNumber = 2) {
  return {
    type: 'response.completed',
    sequenceNumber,
    response: { id: 'r', model: 'm', output, usage: { cost: 0 } },
  };
}

interface CallModelArgs {
  input: unknown[];
  state: StateAccessor;
}

/**
 * Mirror of the SDK's `saveResponseToState` semantics (vendor
 * model-result.js): pending fresh user items + assistant output land in
 * state ATOMICALLY when a response completes — INCLUDING when that output is
 * empty, which is exactly why the empty-response retry must re-issue the
 * cycle with empty input (the user items are already in state).
 */
async function persistLikeSdk(
  args: CallModelArgs,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const prior = (await args.state.load())?.messages;
  const messages = [...(Array.isArray(prior) ? prior : []), ...args.input];
  await args.state.save({ messages, ...extra } as never);
}

/** Attempt that completes with the given final output (persisting like the SDK). */
function attemptWithOutput(output: unknown[]) {
  return (args: CallModelArgs) => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      yield start;
      await persistLikeSdk(args);
      yield completedEvent(output);
    },
    async getResponse() {
      return { id: 'r', model: 'm', output, usage: { cost: 0 } };
    },
  });
}

const emptyAttempt = () => attemptWithOutput([]);
const successfulAttempt = () => attemptWithOutput(TEXT_OUTPUT);

type RunOptions = ConstructorParameters<typeof OpenRouterAgentRun>[0];

let logs: Array<{ level: AgentLoggerLevel; message: string; context?: unknown }> = [];

function makeRun(extra: Partial<RunOptions> = {}): OpenRouterAgentRun {
  return new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: 'sess-empty-response',
    prompt: 'answer me',
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

function userItemsIn(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) => !!m && typeof m === 'object' && (m as { role?: string }).role === 'user',
  );
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  logs = [];
});

describe('empty-response net — retry on blank completed responses', () => {
  it('retries an empty completed response with EMPTY input and the second attempt succeeds', async () => {
    callModelMock
      .mockImplementationOnce(emptyAttempt())
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // The empty attempt's response COMPLETED, so the SDK persisted the fresh
    // user items — the retry must continue from history with empty input.
    const retryArgs = callModelMock.mock.calls[1]![0] as CallModelArgs;
    expect(retryArgs.input).toEqual([]);
    // No duplicated user items in state.
    const state = (await retryArgs.state.load()) as { messages?: unknown } | null;
    expect(userItemsIn(state?.messages)).toHaveLength(1);
    // One warn-level retry log carrying the empty-response reason.
    const warnings = retryWarnings();
    expect(warnings).toHaveLength(1);
    expect((warnings[0]!.context as { reason: string }).reason).toContain('empty response');
  });

  it('surfaces error + stream_complete{status:error} when every attempt is empty', async () => {
    callModelMock.mockImplementation(emptyAttempt());

    const events = await collect(makeRun());

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('empty response');
    // Initial attempt + DEFAULT_MAX_TRANSIENT_RETRIES (2).
    expect(callModelMock).toHaveBeenCalledTimes(3);
    expect(retryWarnings()).toHaveLength(2);
  });

  it('maxTransientRetries: 0 turns an empty response into an immediate error (not silent success)', async () => {
    callModelMock.mockImplementation(emptyAttempt());

    const events = await collect(makeRun({ maxTransientRetries: 0 }));

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toContain('empty response');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(retryWarnings()).toHaveLength(0);
  });

  it('does NOT retry a reasoning-only final response', async () => {
    callModelMock.mockImplementation(
      attemptWithOutput([{ type: 'reasoning', content: [{ text: 'thinking…' }] }]),
    );

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the final output holds only a server-tool item', async () => {
    callModelMock.mockImplementation(
      attemptWithOutput([
        { type: 'openrouter:web_search_call', id: 'st1', status: 'completed', results: [] },
      ]),
    );

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it('streamed text deltas veto the net even when the completed output echo is empty', async () => {
    callModelMock.mockImplementation((args: CallModelArgs) => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield start;
        yield { type: 'response.output_text.delta', delta: 'streamed answer' };
        await persistLikeSdk(args);
        yield completedEvent([]);
      },
      async getResponse() {
        return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
      },
    }));

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('retries when a tool-call turn did work but the FINAL turn came back blank', async () => {
    // Turn 1 streams a tool result; turn 2 (the final answer) is empty. The
    // per-turn activity reset means turn 1's work must not mask turn 2's
    // blankness — the cycle retries and regenerates the final answer from
    // the persisted history.
    callModelMock
      .mockImplementationOnce((args: CallModelArgs) => ({
        cancel: async () => undefined,
        async *getFullResponsesStream() {
          yield start;
          yield {
            type: 'tool.call_output',
            timestamp: 0,
            output: {
              callId: 'c1',
              type: 'function_call_output',
              output: '{}',
              status: 'completed',
            },
          };
          yield completedEvent([
            { type: 'function_call', callId: 'c1', name: 't', arguments: '{}' },
          ]);
          yield { type: 'turn.start', turnNumber: 2, timestamp: 2 };
          await persistLikeSdk(args);
          yield completedEvent([], 3);
        },
        async getResponse() {
          return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
        },
      }))
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(retryWarnings()).toHaveLength(1);
  });

  it('does NOT retry an empty response when the cycle was interrupted', async () => {
    // An interrupt legitimately truncates output — the interrupted status in
    // state must win over the empty net, leaving the normal interrupt path
    // (commit partial response, pull next input) in charge.
    callModelMock.mockImplementation((args: CallModelArgs) => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield start;
        await persistLikeSdk(args, { status: 'interrupted', interruptedBy: 'host' });
        yield completedEvent([]);
      },
      async getResponse() {
        return { id: 'r', model: 'm', output: [], usage: { cost: 0 } };
      },
    }));

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(retryWarnings()).toHaveLength(0);
  });
});
