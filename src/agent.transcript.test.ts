import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

import { OpenRouterAgentRun } from './agent.js';
import { readTranscript, type TranscriptRecord } from './logging/transcript.js';

interface FakeResponse {
  id?: string;
  model?: string;
  usage?: {
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: { cachedTokens?: number };
    outputTokensDetails?: { reasoningTokens?: number };
  };
  output?: unknown[];
}

function fakeCallModel(args: { events: unknown[]; response?: FakeResponse }) {
  return (request: { onTurnEnd?: (ctx: unknown, resp: FakeResponse) => Promise<void> | void }) => {
    const response: FakeResponse = args.response ?? {
      id: 'resp-1',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: [],
    };
    return {
      async *getFullResponsesStream() {
        // Replay the caller's events, then synthesize the `response.completed`
        // event the real SDK emits right before `turn.end`. The transcript
        // writer hangs off this event, so tests that drive the full lifecycle
        // need it present.
        let emittedCompleted = false;
        for (const ev of args.events) {
          if (
            !emittedCompleted &&
            !!ev &&
            typeof ev === 'object' &&
            (ev as { type?: string }).type === 'turn.end'
          ) {
            yield { type: 'response.completed', response, sequenceNumber: 0 };
            emittedCompleted = true;
          }
          yield ev;
        }
        if (request.onTurnEnd) {
          await request.onTurnEnd({ numberOfTurns: 1 }, response);
        }
      },
      async getResponse() {
        return response;
      },
    };
  };
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _e of iter) {
    void _e;
  }
}

async function collectTranscript(logsRoot: string, sessionId: string): Promise<TranscriptRecord[]> {
  const out: TranscriptRecord[] = [];
  for await (const r of readTranscript(logsRoot, sessionId)) out.push(r);
  return out;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

let logsRoot: string;
const SESSION = 'sess_transcript_integration';

beforeEach(async () => {
  logsRoot = await mkdtemp(join(tmpdir(), 'or-agent-transcript-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('OpenRouterAgentRun transcript log', () => {
  // Regression: the OR SDK only fires `onTurnEnd` on follow-up turns (after a
  // tool-execution round). Single-shot runs (no tool calls) trigger zero
  // `onTurnEnd` callbacks — the initial response IS the final response. An
  // earlier version of the transcript writer hung off `onTurnEnd` and so
  // wrote zero assistant records on such runs. Switching the write hook to
  // the `response.completed` stream event (which fires once per turn, initial
  // AND follow-up) fixes that. This test guards the regression.
  it('writes the assistant record on a single-shot run with no tool calls', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'response.output_text.delta', delta: 'single ' },
          { type: 'response.output_text.delta', delta: 'shot' },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r-singleshot',
          model: 'mock-singleshot',
          usage: { cost: 0.001, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'single shot' }],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'one and done',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const assistantRecords = records.filter((r) => r.kind === 'assistant');
    expect(assistantRecords).toHaveLength(1);
    const assistant = assistantRecords[0] as Extract<TranscriptRecord, { kind: 'assistant' }>;
    expect(assistant.text).toBe('single shot');
    expect(assistant.model).toBe('mock-singleshot');
    expect(assistant.costUsd).toBeCloseTo(0.001);
  });

  it('writes session_start → user → assistant (with model/usage/cost) → session_end on a simple turn', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'response.output_text.delta', delta: 'hello ' },
          { type: 'response.output_text.delta', delta: 'world' },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r1',
          model: 'openrouter/auto/resolved-to-claude',
          usage: {
            cost: 0.0034,
            inputTokens: 42,
            outputTokens: 13,
            totalTokens: 55,
            inputTokensDetails: { cachedTokens: 8 },
            outputTokensDetails: { reasoningTokens: 5 },
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello world' }],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'say hi',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const kinds = records.map((r) => r.kind);
    expect(kinds).toEqual(['session_start', 'user', 'assistant', 'session_end']);

    const assistant = records[2] as Extract<TranscriptRecord, { kind: 'assistant' }>;
    expect(assistant.turnNumber).toBe(0);
    expect(assistant.model).toBe('openrouter/auto/resolved-to-claude');
    expect(assistant.text).toBe('hello world');
    expect(assistant.usage).toEqual({
      prompt: 42,
      completion: 13,
      reasoning: 5,
      cached: 8,
    });
    expect(assistant.costUsd).toBeCloseTo(0.0034);
    expect(assistant.requestId).toMatch(/^req_/);

    const sessionEnd = records[3] as Extract<TranscriptRecord, { kind: 'session_end' }>;
    expect(sessionEnd.status).toBe('success');
    expect(sessionEnd.totalCostUsd).toBeCloseTo(0.0034);
  });

  it('captures reasoning content from response.output reasoning items', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r2',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'Let me think… ' }],
            },
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'OK done.' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'answer' }],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'think hard',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const assistant = records.find((r) => r.kind === 'assistant') as Extract<
      TranscriptRecord,
      { kind: 'assistant' }
    >;
    expect(assistant.reasoning).toBe('Let me think… OK done.');
    expect(assistant.text).toBe('answer');
  });

  it('extracts toolCalls from function_call items in response.output (with parsed + raw args + missing callId/name fallbacks + unknown item type)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r-tc',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [
            // Unknown item type — neither message / reasoning / function_call.
            // Exercises the else-if false branch in extractAssistantContent.
            { type: 'web_search_call' },
            {
              type: 'function_call',
              callId: 'c-json',
              name: 'read_file',
              arguments: '{"path":"a.txt"}',
            },
            {
              type: 'function_call',
              callId: 'c-bad',
              name: 'grep',
              arguments: 'not-json',
            },
            {
              type: 'function_call',
              callId: 'c-obj',
              name: 'glob',
              arguments: { pattern: '*.ts' },
            },
            // Missing callId and name (non-string) — exercises the
            // string-fallback branches on both fields.
            {
              type: 'function_call',
              arguments: '{}',
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'multi tools',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const assistant = records.find((r) => r.kind === 'assistant') as Extract<
      TranscriptRecord,
      { kind: 'assistant' }
    >;
    expect(assistant.toolCalls).toEqual([
      { callId: 'c-json', name: 'read_file', input: { path: 'a.txt' } },
      { callId: 'c-bad', name: 'grep', input: 'not-json' },
      { callId: 'c-obj', name: 'glob', input: { pattern: '*.ts' } },
      { callId: '', name: '', input: {} },
    ]);
  });

  it('writes tool_result with the resolved tool name (looked up from tool_call)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 'call_abc',
              name: 'read_file',
              arguments: '{"path":"foo.txt"}',
            },
          },
          {
            type: 'tool.call_output',
            timestamp: 1,
            output: {
              callId: 'call_abc',
              type: 'function_call_output',
              output: 'file body',
              status: 'completed',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'read foo',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const toolResult = records.find((r) => r.kind === 'tool_result') as Extract<
      TranscriptRecord,
      { kind: 'tool_result' }
    >;
    expect(toolResult).toBeDefined();
    expect(toolResult.callId).toBe('call_abc');
    expect(toolResult.name).toBe('read_file');
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('file body');
  });

  it('writes a server_tool record for an openrouter:* output item', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'openrouter:web_search',
              id: 'st_ws',
              status: 'completed',
              action: { type: 'search', query: 'latest harness release' },
            },
          },
          {
            type: 'response.output_item.done',
            outputIndex: 1,
            sequenceNumber: 2,
            item: {
              type: 'openrouter:web_fetch',
              id: 'st_wf',
              status: 'completed',
              url: 'https://example.com',
              error: 'fetch timed out',
            },
          },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'search the web',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const serverTools = records.filter((r) => r.kind === 'server_tool') as Array<
      Extract<TranscriptRecord, { kind: 'server_tool' }>
    >;
    expect(serverTools).toHaveLength(2);

    const search = serverTools.find((r) => r.toolType === 'openrouter:web_search')!;
    expect(search.callId).toBe('st_ws');
    expect(search.status).toBe('completed');
    expect(search.input).toEqual({ query: 'latest harness release' });
    expect(search.isError).toBe(false);
    expect(search.output).toHaveProperty('action');

    const fetch = serverTools.find((r) => r.toolType === 'openrouter:web_fetch')!;
    expect(fetch.callId).toBe('st_wf');
    expect(fetch.isError).toBe(true);
    expect(fetch.output).toMatchObject({ url: 'https://example.com', error: 'fetch timed out' });
  });

  it('tolerates null / unknown items and non-text content in response.output', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
        response: {
          id: 'r-defensive',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [
            // Null item — skipped by the falsy-item guard.
            null,
            {
              type: 'message',
              role: 'assistant',
              content: [
                // Wrong content type — skipped (covers the && short-circuit).
                { type: 'refusal', text: 'no thanks' },
                // Output text with non-string text — skipped (covers typeof guard).
                { type: 'output_text', text: 42 },
                // Valid text — captured.
                { type: 'output_text', text: 'real answer' },
              ],
            },
            {
              type: 'reasoning',
              content: [
                // Missing text — skipped.
                { type: 'reasoning_text' },
                // Non-string text — skipped.
                { type: 'reasoning_text', text: null },
                // Valid text — captured.
                { type: 'reasoning_text', text: 'real thought' },
              ],
            },
          ],
        },
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'defensive',
      logsRoot,
    });
    await drain(run);

    const records = await collectTranscript(logsRoot, SESSION);
    const assistant = records.find((r) => r.kind === 'assistant') as Extract<
      TranscriptRecord,
      { kind: 'assistant' }
    >;
    expect(assistant.text).toBe('real answer');
    expect(assistant.reasoning).toBe('real thought');
    expect(assistant.toolCalls).toBeUndefined();
  });

  it('writes nothing under logsRoot when persistSession is false', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0, timestamp: 1 },
          { type: 'response.output_text.delta', delta: 'noop' },
          { type: 'turn.end', turnNumber: 0, timestamp: 2 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'no persist',
      logsRoot,
      persistSession: false,
    });
    await drain(run);

    expect(existsSync(join(logsRoot, SESSION, 'transcript.jsonl'))).toBe(false);
    expect(existsSync(join(logsRoot, SESSION, 'session.json'))).toBe(false);

    const records = await collectTranscript(logsRoot, SESSION);
    expect(records).toEqual([]);
  });
});
