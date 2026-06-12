import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
import type { AgentLoggerLevel } from './agent.js';
import type { AgentCoreEvent } from './events.js';
import type { StateAccessor } from '@openrouter/agent';

const start = { type: 'turn.start', turnNumber: 1, timestamp: 1 };

const serverErrorEvent = {
  type: 'response.failed',
  sequenceNumber: 1,
  response: { error: { code: 'server_error', message: 'Internal Server Error' } },
};

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
}

/**
 * Mirror of the SDK's `saveResponseToState` semantics (vendor
 * model-result.js): pending fresh user items + assistant output land in
 * state ATOMICALLY when a response completes. A cycle that dies before its
 * first completed response writes nothing.
 */
async function persistLikeSdk(args: CallModelArgs): Promise<void> {
  const prior = (await args.state.load())?.messages;
  const messages = [
    ...(Array.isArray(prior) ? prior : []),
    ...args.input,
    { type: 'message', role: 'assistant', content: 'ok' },
  ];
  await args.state.save({ messages } as never);
}

/** Attempt that dies with `response.failed` BEFORE any response completes —
 * the SDK persists nothing to state in this shape. */
function failingAttempt(failedEvent: unknown = serverErrorEvent) {
  return (_args: CallModelArgs) => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      yield start;
      yield failedEvent;
    },
    async getResponse(): Promise<unknown> {
      throw new Error('Response failed: {"code":"server_error"}');
    },
  });
}

/** Attempt whose stream throws mid-iteration (HTTP-level failure shapes). */
function throwingAttempt(err: unknown) {
  return (_args: CallModelArgs) => ({
    cancel: async () => undefined,
    // eslint-disable-next-line require-yield
    async *getFullResponsesStream(): AsyncGenerator<unknown> {
      throw err;
    },
    async getResponse(): Promise<unknown> {
      throw err;
    },
  });
}

/** Attempt that completes one response, persisting fresh input + assistant
 * output exactly like the SDK does on success. */
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

/** Attempt whose FIRST turn completes (fresh items persisted!) but whose
 * follow-up turn dies with a transient failure. */
function followUpFailureAttempt() {
  return (args: CallModelArgs) => ({
    cancel: async () => undefined,
    async *getFullResponsesStream() {
      yield start;
      await persistLikeSdk(args);
      yield completedEvent(0);
      yield { type: 'turn.start', turnNumber: 2, timestamp: 2 };
      yield serverErrorEvent;
    },
    async getResponse(): Promise<unknown> {
      throw new Error('Response failed: {"code":"server_error"}');
    },
  });
}

type RunOptions = ConstructorParameters<typeof OpenRouterAgentRun>[0];

let logs: Array<{ level: AgentLoggerLevel; message: string; context?: unknown }> = [];

function makeRun(extra: Partial<RunOptions> = {}): OpenRouterAgentRun {
  return new OpenRouterAgentRun({
    apiKey: 'sk-test',
    sessionId: 'sess-transient-retry',
    prompt: 'retry me',
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

async function loadedStateOf(callIndex: number): Promise<unknown> {
  const args = callModelMock.mock.calls[callIndex]![0] as CallModelArgs;
  return args.state.load();
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  logs = [];
});

describe('transient-failure retry — retryable classes', () => {
  it('retries a server_error response.failed with the SAME fresh input and completes', async () => {
    callModelMock
      .mockImplementationOnce(failingAttempt())
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun({ transientRetryBaseDelayMs: 1 }));

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // Same fresh input re-issued verbatim — retrying is safe because the
    // failed attempt persisted nothing (verified against state below).
    const firstInput = (callModelMock.mock.calls[0]![0] as CallModelArgs).input;
    const secondInput = (callModelMock.mock.calls[1]![0] as CallModelArgs).input;
    expect(secondInput).toEqual(firstInput);
    expect(firstInput).toEqual([{ role: 'user', content: 'retry me' }]);
    // No duplication: the fresh user item appears exactly once in state.
    const state = (await loadedStateOf(0)) as { messages?: unknown };
    expect(userItemsIn(state.messages)).toHaveLength(1);
    // One warn-level retry log with reason + attempt number + backoff.
    const warns = retryWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]!.context).toEqual({
      reason: 'server_error: Internal Server Error',
      attempt: 1,
      maxRetries: 2,
      backoffMs: 1,
    });
  });

  it('retries an overloaded response.failed', async () => {
    callModelMock
      .mockImplementationOnce(
        failingAttempt({
          type: 'response.failed',
          sequenceNumber: 1,
          response: { error: { code: 'overloaded', message: 'Provider overloaded' } },
        }),
      )
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
  });

  it('retries an HTTP 5xx statusCode error thrown from the stream (non-Error shape)', async () => {
    callModelMock
      .mockImplementationOnce(throwingAttempt({ statusCode: 502 }))
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // Non-Error throw exercises the String(err) reason fallback.
    expect((retryWarnings()[0]!.context as { reason: string }).reason).toBe('[object Object]');
  });

  it('retries when the 5xx statusCode sits on the error cause (silent-hang rethrow shape)', async () => {
    const cause = Object.assign(new Error('Bad Gateway'), { statusCode: 502 });
    callModelMock
      .mockImplementationOnce(throwingAttempt(new Error('wrapped sdk error', { cause })))
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect((retryWarnings()[0]!.context as { reason: string }).reason).toBe('wrapped sdk error');
  });

  it('retries a follow-up-turn failure with an EMPTY input (fresh items already persisted)', async () => {
    callModelMock
      .mockImplementationOnce(followUpFailureAttempt())
      .mockImplementationOnce(successfulAttempt());

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('success');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // First attempt completed a response → SDK persisted the fresh items →
    // the retry must NOT re-send them.
    const secondInput = (callModelMock.mock.calls[1]![0] as CallModelArgs).input;
    expect(secondInput).toEqual([]);
    // The user item still appears exactly once in state.
    const state = (await loadedStateOf(0)) as { messages?: unknown };
    expect(userItemsIn(state.messages)).toHaveLength(1);
  });

  it('does not double-count turns from a failed-and-retried cycle toward max_turns', async () => {
    callModelMock
      .mockImplementationOnce(failingAttempt())
      .mockImplementationOnce(successfulAttempt(0.25));

    // Failed attempt + retry each observe turnNumber 1. Cumulative counting
    // would put maxTurnNumber at 2 → (2 + 1) >= 3 → spurious 'max_turns'.
    const events = await collect(makeRun({ maxTurns: 3 }));

    const complete = completeOf(events);
    expect(complete.status).toBe('success');
    // Cost reflects only the successful attempt (the failed one never
    // produced a usage report — costUsd 0, matching the incident shape).
    expect(complete.costUsd).toBe(0.25);
  });

  it('drains the failed attempt’s pending SDK rejection during the backoff window', async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Mirrors the real SDK shape (see agent.chained-promise-rejection.test.ts):
      // getResponse() returns the rejected toolExecutionPromise; the SDK
      // generator awaits the separately-chained executionPromise after the
      // broadcast drains, throwing into the harness for-await.
      const toolExecutionPromise: Promise<unknown> = Promise.reject(
        new Error('Response failed: {"code":"server_error","message":"Internal Server Error"}'),
      );
      const executionPromise: Promise<unknown> = toolExecutionPromise.finally(() => undefined);
      callModelMock
        .mockImplementationOnce(() => ({
          cancel: async () => undefined,
          async *getFullResponsesStream() {
            yield start;
            yield serverErrorEvent;
            await executionPromise;
          },
          getResponse: () => toolExecutionPromise,
        }))
        .mockImplementationOnce(successfulAttempt());

      const events = await collect(makeRun({ transientRetryBaseDelayMs: 1 }));

      expect(completeOf(events).status).toBe('success');
      expect(callModelMock).toHaveBeenCalledTimes(2);
      // Give Node's unhandled-rejection detection time to fire if the
      // rejection had been left unobserved across the backoff sleep.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('transient-failure retry — exhaustion and non-retryable classes', () => {
  it('surfaces the error after exhausting maxTransientRetries', async () => {
    callModelMock.mockImplementation(failingAttempt());

    const events = await collect(makeRun({ maxTransientRetries: 1 }));

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('server_error: Internal Server Error');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(retryWarnings()).toHaveLength(1);
  });

  it('maxTransientRetries: 0 disables retries entirely', async () => {
    callModelMock.mockImplementation(failingAttempt());

    const events = await collect(makeRun({ maxTransientRetries: 0 }));

    expect(completeOf(events).status).toBe('error');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(retryWarnings()).toHaveLength(0);
  });

  it.each([
    [
      'a deterministic error code',
      {
        type: 'response.failed',
        sequenceNumber: 1,
        response: { error: { code: 'moderation', message: 'blocked' } },
      },
      'moderation: blocked',
    ],
    [
      'a null error envelope',
      {
        type: 'response.failed',
        sequenceNumber: 1,
        message: 'edge gave up',
        response: { error: null },
      },
      'edge gave up',
    ],
    [
      'a missing response payload',
      { type: 'response.failed', sequenceNumber: 1 },
      'Response failed',
    ],
  ])('does not retry a response.failed with %s', async (_label, failedEvent, expectedReason) => {
    callModelMock.mockImplementation(failingAttempt(failedEvent));

    const events = await collect(makeRun());

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe(expectedReason);
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an HTTP 4xx statusCode error',
      Object.assign(new Error('Bad Request: Status 400'), { statusCode: 400 }),
    ],
    ['a generic Error without statusCode', new Error('boom')],
    ['an Error with a null cause', new Error('boom', { cause: null })],
    ['a thrown string', 'string failure'],
    ['a thrown null', null],
  ])('does not retry %s thrown from the stream', async (_label, err) => {
    callModelMock.mockImplementation(throwingAttempt(err));

    const events = await collect(makeRun());

    expect(completeOf(events).status).toBe('error');
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the signal aborted mid-stream, even on a 5xx', async () => {
    const controller = new AbortController();
    callModelMock.mockImplementation(() => ({
      cancel: async () => undefined,
      async *getFullResponsesStream() {
        yield start;
        controller.abort();
        throw Object.assign(new Error('Internal: Status 500'), { statusCode: 500 });
      },
      async getResponse(): Promise<unknown> {
        throw new Error('cancelled');
      },
    }));

    const events = await collect(makeRun({ signal: controller.signal }));

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry when the signal aborts during the backoff window', async () => {
    const controller = new AbortController();
    callModelMock.mockImplementation(failingAttempt());

    const startedAt = Date.now();
    const eventsPromise = collect(
      makeRun({ signal: controller.signal, transientRetryBaseDelayMs: 60_000 }),
    );
    // Fire the abort while the run sleeps through the (60s) backoff.
    setTimeout(() => controller.abort(), 25);
    const events = await eventsPromise;

    const complete = completeOf(events);
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // Only the failed attempt ran — no second callModel was issued — and the
    // abort short-circuited the backoff sleep instead of waiting it out.
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('transient-failure retry — persisted-session log layout', () => {
  const tmpRoot = join(process.cwd(), '.test-tmp', 'transient-retry-logs');

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('keeps one request directory and one user transcript record for a retried cycle', async () => {
    callModelMock
      .mockImplementationOnce(failingAttempt())
      .mockImplementationOnce(successfulAttempt());

    const sessionId = 'sess-retry-logs';
    const events = await collect(makeRun({ sessionId, persistSession: true, logsRoot: tmpRoot }));

    expect(completeOf(events).status).toBe('success');
    // The retry reuses the failed cycle's request id — `logs/<session>/req_*/`
    // stays 1:1 with logical cycles, not with wire attempts.
    const sessionDir = join(tmpRoot, sessionId);
    const reqDirs = (await readdir(sessionDir)).filter((name) => name.startsWith('req_'));
    expect(reqDirs).toHaveLength(1);
    // Exactly one user record in the transcript (no duplicate from the retry).
    const transcript = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8');
    const userRecords = transcript
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string })
      .filter((rec) => rec.kind === 'user');
    expect(userRecords).toHaveLength(1);
  });
});
