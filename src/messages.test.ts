import { describe, it, expect } from 'vitest';
import { aggregateMessages, type AgentMessage } from './messages.js';
import type { AgentCoreEvent, TokenUsage } from './events.js';

const usage = (
  cost: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
): TokenUsage =>
  ({
    cost,
    inputTokens,
    outputTokens,
    totalTokens,
    inputTokensDetails: {},
    outputTokensDetails: {},
  }) as unknown as TokenUsage;

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function collect(iter: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe('aggregateMessages', () => {
  it('aggregates a multi-turn run with text + tool into typed messages', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 'sess-1' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'hello' },
      { type: 'text_delta', content: ' world' },
      { type: 'tool_call', callId: 'call_a', name: 'echo', input: { v: 1 } },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'tool_result', callId: 'call_a', output: 'ok', isError: false },
      { type: 'turn_start', turnNumber: 1 },
      { type: 'text_delta', content: 'done' },
      { type: 'turn_end', turnNumber: 1, usage: null, costUsd: 0 },
      {
        type: 'stream_complete',
        status: 'success',
        usage: usage(0.01, 1, 2, 3),
        costUsd: 0.01,
        durationMs: 42,
      },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));

    expect(msgs).toEqual([
      { type: 'system', subtype: 'session_start', sessionId: 'sess-1' },
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'call_a', name: 'echo', input: { v: 1 } },
        ],
      },
      {
        type: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_a', output: 'ok', isError: false }],
      },
      { type: 'assistant', content: [{ type: 'text', text: 'done' }] },
      {
        type: 'result',
        status: 'success',
        usage: usage(0.01, 1, 2, 3),
        costUsd: 0.01,
        durationMs: 42,
      },
      { type: 'system', subtype: 'session_end', sessionId: 'sess-1' },
    ]);
  });

  it('yields no AssistantMessage for an empty turn (turn_end without text or tool)', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    expect(msgs.filter((m) => m.type === 'assistant')).toHaveLength(0);
    // Bookends still present.
    expect(msgs[0]).toEqual({ type: 'system', subtype: 'session_start', sessionId: 's' });
    expect(msgs.at(-1)).toEqual({ type: 'system', subtype: 'session_end', sessionId: 's' });
  });

  it('emits a tool-only AssistantMessage (no TextContent) when a tool_call lands without text deltas', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'tool_call', callId: 'c1', name: 'do_thing', input: { x: 1 } },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'tool_result', callId: 'c1', output: 'done', isError: false },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'do_thing', input: { x: 1 } }],
    });
  });

  it('opens a fresh TextContent when text_delta follows tool_call within the same turn', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'before' },
      { type: 'tool_call', callId: 'c1', name: 't', input: {} },
      { type: 'text_delta', content: 'after' },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'c1', name: 't', input: {} },
        { type: 'text', text: 'after' },
      ],
    });
  });

  it('flushes the open AssistantMessage before a tool_result that arrives mid-turn', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'thinking' },
      { type: 'tool_call', callId: 'c1', name: 't', input: {} },
      { type: 'tool_result', callId: 'c1', output: 'r', isError: false },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const types = msgs.map((m) => m.type);
    // assistant must precede user even though tool_result lands before turn_end.
    const assistantIdx = types.indexOf('assistant');
    const userIdx = types.indexOf('user');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(assistantIdx);
  });

  it('flushes any open AssistantMessage on abort and emits ResultMessage{reason:aborted}', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'partial...' },
      {
        type: 'stream_complete',
        status: 'error',
        reason: 'aborted',
        durationMs: 5,
        usage: null,
        costUsd: 0,
      },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    expect(msgs).toEqual([
      { type: 'system', subtype: 'session_start', sessionId: 's' },
      { type: 'assistant', content: [{ type: 'text', text: 'partial...' }] },
      {
        type: 'result',
        status: 'error',
        reason: 'aborted',
        durationMs: 5,
        usage: null,
        costUsd: 0,
      },
      { type: 'system', subtype: 'session_end', sessionId: 's' },
    ]);
  });

  it('stringifies non-string tool_result output into ToolResultContent.output', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'tool_call', callId: 'c1', name: 't', input: {} },
      { type: 'tool_result', callId: 'c1', output: { ok: true, n: 3 }, isError: false },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const user = msgs.find((m) => m.type === 'user') as Extract<AgentMessage, { type: 'user' }>;
    expect(user.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'c1',
      output: '{"ok":true,"n":3}',
      isError: false,
    });
  });

  it('ignores turn_start and error events (no message-level mapping)', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'error', message: 'boom' },
      { type: 'stream_complete', status: 'error', reason: 'boom' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    expect(msgs.map((m) => m.type)).toEqual(['system', 'result', 'system']);
  });

  it('buffers reasoning_delta into a ThinkingContent block that precedes the turn text', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'reasoning_delta', content: 'let me ' },
      { type: 'reasoning_delta', content: 'think' },
      { type: 'text_delta', content: 'the answer' },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'the answer' },
      ],
    });
  });

  it('emits a thinking-only AssistantMessage when a turn produces reasoning but no text or tools', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'reasoning_delta', content: 'pure thought' },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [{ type: 'thinking', thinking: 'pure thought' }],
    });
  });

  it('keeps interleaved thinking/text/tool blocks in strict event order, reopening blocks after each switch', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'reasoning_delta', content: 'plan A' },
      { type: 'text_delta', content: 'first' },
      // A later reasoning burst within the same turn opens a FRESH thinking
      // block (the earlier one closed when text arrived)…
      { type: 'reasoning_delta', content: 'plan B' },
      // …and text after that reopens a fresh text block too.
      { type: 'text_delta', content: 'second' },
      // A tool call closes both open blocks.
      { type: 'tool_call', callId: 'c1', name: 't', input: {} },
      { type: 'reasoning_delta', content: 'post-tool thought' },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan A' },
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'plan B' },
        { type: 'text', text: 'second' },
        { type: 'tool_use', id: 'c1', name: 't', input: {} },
        { type: 'thinking', thinking: 'post-tool thought' },
      ],
    });
  });

  it('uses the fallback sessionId for session_end when session_started was never observed', async () => {
    // Pre-aborted-at-construction shape: stream_complete only.
    const events: AgentCoreEvent[] = [
      { type: 'stream_complete', status: 'error', reason: 'aborted', durationMs: 1 },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events), 'fallback-sess'));
    expect(msgs).toEqual([
      { type: 'result', status: 'error', reason: 'aborted', durationMs: 1 },
      { type: 'system', subtype: 'session_end', sessionId: 'fallback-sess' },
    ]);
  });

  it('suppresses the session_end bookend when no sessionId is available at all', async () => {
    const events: AgentCoreEvent[] = [{ type: 'stream_complete', status: 'error' }];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    expect(msgs).toEqual([{ type: 'result', status: 'error' }]);
  });

  it('projects a server_tool event onto a tool_use + tool_result pair', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      {
        type: 'server_tool',
        toolType: 'openrouter:web_search',
        callId: 'st_ws',
        status: 'completed',
        input: { query: 'cats' },
        output: { action: { query: 'cats' } },
        isError: false,
      },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant');
    expect(assistant).toEqual({
      type: 'assistant',
      content: [
        { type: 'tool_use', id: 'st_ws', name: 'openrouter:web_search', input: { query: 'cats' } },
      ],
    });
    const user = msgs.find((m) => m.type === 'user');
    expect(user).toEqual({
      type: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'st_ws',
          output: JSON.stringify({ action: { query: 'cats' } }),
          isError: false,
        },
      ],
    });
  });

  it('falls back to toolType as the correlation id when a server_tool omits callId', async () => {
    const events: AgentCoreEvent[] = [
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      {
        type: 'server_tool',
        toolType: 'openrouter:datetime',
        status: 'completed',
        output: { datetime: '2026-06-11T00:00:00Z' },
        isError: false,
      },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success' },
    ];
    const msgs = await collect(aggregateMessages(fromArray(events)));
    const assistant = msgs.find((m) => m.type === 'assistant') as {
      content: Array<{ type: string; id: string }>;
    };
    expect(assistant.content[0].id).toBe('openrouter:datetime');
    const user = msgs.find((m) => m.type === 'user') as {
      content: Array<{ toolUseId: string }>;
    };
    expect(user.content[0].toolUseId).toBe('openrouter:datetime');
  });
});
