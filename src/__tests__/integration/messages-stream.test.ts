import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGate, loadFixture, type MockState } from './mock-openrouter.js';

const { state } = vi.hoisted(() => {
  const sharedState: MockState = {
    fixture: null,
    ctorArgs: [],
    callModelArgs: [],
    pausedGate: null,
    constructorThrows: null,
  };
  return { state: sharedState };
});

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const { createOpenRouterMockModule } = await import('./mock-openrouter.js');
  return { ...actual, ...createOpenRouterMockModule(state) };
});

vi.mock('../../tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../index.js';
import type { AgentMessage, AssistantMessage, UserMessage, ResultMessage } from '../../index.js';

const TEST_SESSION = 'integration-messages-stream-session';

function echoTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'echo',
      description: 'returns the value field of its input',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async (input: { value: string }) => `echoed:${input.value}`,
    },
  };
}

async function collect(stream: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

beforeEach(() => {
  state.fixture = null;
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
});

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('integration: messages() typed stream', () => {
  it('aggregates a multi-turn-with-tool fixture into [system, assistant, user, assistant, result, system]', async () => {
    state.fixture = loadFixture('multi-turn-with-tool');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const msgs = await collect(run.messages());

    // First and last are system bookends.
    expect(msgs[0]).toEqual({
      type: 'system',
      subtype: 'session_start',
      sessionId: TEST_SESSION,
    });
    expect(msgs.at(-1)).toEqual({
      type: 'system',
      subtype: 'session_end',
      sessionId: TEST_SESSION,
    });

    // Turn 0: text "thinking..." then tool_call echo({value:"hello"}).
    const firstAssistant = msgs[1] as AssistantMessage;
    expect(firstAssistant.type).toBe('assistant');
    expect(firstAssistant.content).toEqual([
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'call_a', name: 'echo', input: { value: 'hello' } },
    ]);

    // Tool result lands as a UserMessage with one ToolResultContent matching the call id.
    const userMsg = msgs[2] as UserMessage;
    expect(userMsg.type).toBe('user');
    expect(userMsg.content).toEqual([
      { type: 'tool_result', toolUseId: 'call_a', output: 'echoed:hello', isError: false },
    ]);

    // Turn 1 produces another AssistantMessage with text "done".
    const secondAssistant = msgs[3] as AssistantMessage;
    expect(secondAssistant.type).toBe('assistant');
    expect(secondAssistant.content).toEqual([{ type: 'text', text: 'done' }]);

    // ResultMessage carries success + usage from the fixture.
    const result = msgs[4] as ResultMessage;
    expect(result.type).toBe('result');
    expect(result.status).toBe('success');
    expect(result.usage?.totalTokens).toBe(28);
    expect(result.reason).toBeUndefined();
    expect(result.costUsd).toBeCloseTo(0.002);
  });

  it('flushes the flushed AssistantMessage and emits ResultMessage{reason:aborted} + session_end when the stream aborts then throws', async () => {
    // The abort-then-throw fixture closes turn 0 cleanly (so the
    // AssistantMessage has already been flushed by turn_end), then pauses on a
    // gate, then throws after abort. Verifies the aggregator's terminator path
    // and that no post-abort tool_call leaks into the message stream.
    state.fixture = loadFixture('abort-then-throw');
    const gate = createGate();
    state.pausedGate = gate;

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'will be aborted then thrown',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });

    const msgs: AgentMessage[] = [];
    let aborted = false;
    for await (const m of run.messages()) {
      msgs.push(m);
      // First assistant message means turn 0 has ended cleanly with its text
      // buffered. Abort + release the gate so the run wakes up into the
      // aborted state and proceeds to throw → catch → stream_complete{aborted}.
      if (!aborted && m.type === 'assistant') {
        aborted = true;
        run.abort();
        gate.resolve();
      }
    }

    expect(msgs[0]).toEqual({
      type: 'system',
      subtype: 'session_start',
      sessionId: TEST_SESSION,
    });
    const assistant = msgs.find((m) => m.type === 'assistant') as AssistantMessage;
    expect(assistant.content).toEqual([{ type: 'text', text: 'partial' }]);
    // The dropped tool_call (call_dropped) must NOT appear in the message stream.
    const allToolUseIds = msgs
      .filter((m): m is AssistantMessage => m.type === 'assistant')
      .flatMap((m) => m.content.filter((c) => c.type === 'tool_use').map((c) => c.id));
    expect(allToolUseIds).not.toContain('call_dropped');

    const result = msgs.find((m) => m.type === 'result') as ResultMessage;
    expect(result).toBeDefined();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('aborted');
    // Pre-abort cost tally survives.
    expect(result.costUsd).toBeCloseTo(0.05);

    expect(msgs.at(-1)).toEqual({
      type: 'system',
      subtype: 'session_end',
      sessionId: TEST_SESSION,
    });
  });

  it('preserves the existing event-stream view — calling messages() trips the single-consumer guard for for-await', async () => {
    state.fixture = loadFixture('multi-turn-with-tool');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    // Drain via messages() — consumes the run.
    await collect(run.messages());
    // A second iteration of any kind must throw the single-shot error.
    expect(() => run[Symbol.asyncIterator]()).toThrow(/single-shot/);
  });

  it('existing event-stream iteration continues to work unchanged when messages() is NOT called', async () => {
    // Regression guard: the addition of messages() must not perturb the raw
    // event stream consumers.
    state.fixture = loadFixture('multi-turn-with-tool');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events: string[] = [];
    for await (const e of run) events.push(e.type);
    expect(events[0]).toBe('session_started');
    expect(events.at(-1)).toBe('stream_complete');
    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
  });
});
