import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

// Mirrors the mock harness in agent.test.ts: stub @openrouter/agent's OpenRouter
// client + the SDK type guards keyed on the discriminant strings the fake
// stream below emits, so we drive the raw SSE → AgentCoreEvent translation
// directly.
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
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { AgentCoreEvent } from './events.js';

interface FakeResponse {
  id?: string;
  model?: string;
  usage?: { cost?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
  output?: unknown[];
}

function fakeCallModel(events: unknown[], response?: FakeResponse) {
  return () => {
    const resp: FakeResponse = response ?? {
      id: 'resp-1',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: [],
    };
    return {
      async *getFullResponsesStream() {
        for (const ev of events) yield ev;
      },
      async getResponse() {
        return resp;
      },
    };
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

const TEST_SESSION = 'test-message-item-boundary-session';

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

type StartEvent = Extract<AgentCoreEvent, { type: 'message_item_start' }>;

describe('message_item_start boundary events', () => {
  it('emits a boundary before each of two consecutive message items, with text_delta verbatim and in order', async () => {
    callModelMock.mockImplementation(
      fakeCallModel([
        { type: 'turn.start', turnNumber: 0, timestamp: 1 },
        {
          type: 'response.output_item.added',
          outputIndex: 0,
          sequenceNumber: 1,
          item: { type: 'message', id: 'msg_a', role: 'assistant', phase: 'commentary' },
        },
        { type: 'response.output_text.delta', delta: 'first ' },
        { type: 'response.output_text.delta', delta: 'message' },
        {
          type: 'response.output_item.added',
          outputIndex: 1,
          sequenceNumber: 2,
          item: { type: 'message', id: 'msg_b', role: 'assistant', phase: 'final_answer' },
        },
        { type: 'response.output_text.delta', delta: 'second' },
        { type: 'turn.end', turnNumber: 0, timestamp: 2 },
      ]),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'hi',
    });
    const events = await collect(run);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'turn_start',
      'message_item_start',
      'text_delta',
      'text_delta',
      'message_item_start',
      'text_delta',
      'turn_end',
      'stream_complete',
    ]);

    const starts = events.filter((e): e is StartEvent => e.type === 'message_item_start');
    expect(starts).toEqual([
      {
        type: 'message_item_start',
        kind: 'message',
        itemId: 'msg_a',
        outputIndex: 0,
        phase: 'commentary',
      },
      {
        type: 'message_item_start',
        kind: 'message',
        itemId: 'msg_b',
        outputIndex: 1,
        phase: 'final_answer',
      },
    ]);

    // Deltas stream verbatim — no trimming, no combining, no separators.
    const deltas = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { content: string }).content);
    expect(deltas).toEqual(['first ', 'message', 'second']);
  });

  it('emits a distinct boundary for a message → reasoning → message sequence (reasoning carries no phase), with a function_call still translated', async () => {
    callModelMock.mockImplementation(
      fakeCallModel([
        { type: 'turn.start', turnNumber: 0, timestamp: 1 },
        {
          type: 'response.output_item.added',
          outputIndex: 0,
          sequenceNumber: 1,
          item: { type: 'reasoning', id: 'rsn_0' },
        },
        { type: 'response.reasoning_text.delta', delta: 'thinking...' },
        {
          type: 'response.output_item.added',
          outputIndex: 1,
          sequenceNumber: 2,
          item: { type: 'message', id: 'msg_0', role: 'assistant', phase: 'commentary' },
        },
        { type: 'response.output_text.delta', delta: 'let me call a tool' },
        // function_call items must NOT emit a boundary — they flush via tool_call.
        {
          type: 'response.output_item.added',
          outputIndex: 2,
          sequenceNumber: 3,
          item: {
            type: 'function_call',
            id: 'fc_0',
            callId: 'call_1',
            name: 'read_file',
            arguments: '{}',
          },
        },
        {
          type: 'response.output_item.done',
          outputIndex: 2,
          sequenceNumber: 4,
          item: {
            type: 'function_call',
            callId: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        },
        {
          type: 'response.output_item.added',
          outputIndex: 3,
          sequenceNumber: 5,
          item: { type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer' },
        },
        { type: 'response.output_text.delta', delta: 'done' },
        { type: 'turn.end', turnNumber: 0, timestamp: 2 },
      ]),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'go',
    });
    const events = await collect(run);

    const starts = events.filter((e): e is StartEvent => e.type === 'message_item_start');
    expect(starts).toEqual([
      { type: 'message_item_start', kind: 'reasoning', itemId: 'rsn_0', outputIndex: 0 },
      {
        type: 'message_item_start',
        kind: 'message',
        itemId: 'msg_0',
        outputIndex: 1,
        phase: 'commentary',
      },
      {
        type: 'message_item_start',
        kind: 'message',
        itemId: 'msg_1',
        outputIndex: 3,
        phase: 'final_answer',
      },
    ]);
    // Reasoning boundary carries no phase field at all.
    expect('phase' in starts[0]).toBe(false);

    // The function_call still translates to a single tool_call (no boundary for it).
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toEqual([
      { type: 'tool_call', callId: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ]);

    // Ordering: reasoning boundary precedes its reasoning_delta; message boundary
    // precedes its text_delta.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'turn_start',
      'message_item_start', // reasoning
      'reasoning_delta',
      'message_item_start', // message (commentary)
      'text_delta',
      'tool_call',
      'message_item_start', // message (final_answer)
      'text_delta',
      'turn_end',
      'stream_complete',
    ]);
  });

  it('surfaces a proxy-stamped session_id on the boundary when present', async () => {
    callModelMock.mockImplementation(
      fakeCallModel([
        { type: 'turn.start', turnNumber: 0, timestamp: 1 },
        {
          type: 'response.output_item.added',
          outputIndex: 0,
          sequenceNumber: 1,
          item: {
            type: 'message',
            id: 'msg_s',
            role: 'assistant',
            phase: 'commentary',
            session_id: 'sess-xyz',
          },
        },
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'turn.end', turnNumber: 0, timestamp: 2 },
      ]),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'hi',
    });
    const events = await collect(run);
    const start = events.find((e): e is StartEvent => e.type === 'message_item_start');
    expect(start).toEqual({
      type: 'message_item_start',
      kind: 'message',
      itemId: 'msg_s',
      outputIndex: 0,
      phase: 'commentary',
      sessionId: 'sess-xyz',
    });
  });

  it('emits exactly one boundary for a single-message response and no spurious extras', async () => {
    callModelMock.mockImplementation(
      fakeCallModel([
        { type: 'turn.start', turnNumber: 0, timestamp: 1 },
        {
          type: 'response.output_item.added',
          outputIndex: 0,
          sequenceNumber: 1,
          item: { type: 'message', id: 'only', role: 'assistant', phase: 'final_answer' },
        },
        { type: 'response.output_text.delta', delta: 'hello world' },
        { type: 'turn.end', turnNumber: 0, timestamp: 2 },
      ]),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: TEST_SESSION,
      prompt: 'hi',
    });
    const events = await collect(run);
    const starts = events.filter((e) => e.type === 'message_item_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      type: 'message_item_start',
      kind: 'message',
      itemId: 'only',
      outputIndex: 0,
      phase: 'final_answer',
    });
  });
});
