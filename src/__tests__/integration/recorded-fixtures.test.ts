// Verification test for live-recorded fixtures (Phase 3.3.5).
//
// These tests load fixtures produced by `npm run record:fixture` and replay
// them through the existing mock-openrouter to confirm the recorder's
// post-processed output is consumed cleanly by OpenRouterAgentRun. Assertions
// are shape-only (no exact token-count checks) since live recordings vary
// turn-to-turn — that's by design, and exactly why these tests sit alongside
// the synthetic full-run.test.ts rather than replacing any of its fixtures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFixture, type MockState } from './mock-openrouter.js';

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
import type { AgentCoreEvent } from '../../index.js';

const TEST_SESSION = 'integration-recorded-fixtures-session';

interface EchoTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (input: { value: string }) => Promise<string>;
  };
}

function echoTool(): EchoTool {
  return {
    type: 'function',
    function: {
      name: 'echo',
      description: 'returns the value field of its input',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async (input) => `echoed:${input.value}`,
    },
  };
}

async function collect(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const out: AgentCoreEvent[] = [];
  for await (const e of run) out.push(e);
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

describe('integration: recorded fixtures (live-recorded via scripts/record-fixture.ts)', () => {
  it('multi-turn-with-tool-haiku (anthropic/claude-haiku-4.5): replays cleanly with a tool call and final reply', async () => {
    state.fixture = loadFixture('multi-turn-with-tool-haiku');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'recorded multi-turn',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('session_started');
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('turn_end');

    const toolCall = events.find((e) => e.type === 'tool_call') as Extract<
      AgentCoreEvent,
      { type: 'tool_call' }
    >;
    expect(toolCall.name).toBe('echo');
    expect(toolCall.input).toMatchObject({ value: 'hello' });

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:hello');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
    // Recorded usage / cost are non-deterministic but should be defined &
    // positive — assert shape, not exact numbers.
    expect(complete.usage?.totalTokens).toBeGreaterThan(0);
    expect(complete.costUsd).toBeGreaterThan(0);
  });

  it('single-tool-call-gemini (google/gemini-3.5-flash): replays cleanly with a tool call', async () => {
    state.fixture = loadFixture('single-tool-call-gemini');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'recorded gemini tool call',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('session_started');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');

    const toolCall = events.find((e) => e.type === 'tool_call') as Extract<
      AgentCoreEvent,
      { type: 'tool_call' }
    >;
    expect(toolCall.name).toBe('echo');
    expect(toolCall.input).toMatchObject({ value: 'gated' });

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:gated');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('recorded fixtures contain no `sk-or-*` API key substring (sanitization gate)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ['multi-turn-with-tool-haiku', 'single-tool-call-gemini']) {
      const raw = readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8');
      expect(raw).not.toMatch(/sk-or-[A-Za-z0-9_-]+/);
    }
  });
});
