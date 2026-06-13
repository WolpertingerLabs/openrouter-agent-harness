// NOTE: A cosmetic `close timed out after 10000ms` message can appear AFTER
// `Tests closed successfully` when this file runs in vitest. Same root cause
// as `src/mcp/transport-stdio.test.ts` (PR #115) — the SDK's stdio transport
// cleanup outliving vitest's pool-close gate. Exit code is 0 and 100% of
// tests pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createGate, type Fixture, type MockState } from '../mock-openrouter.js';

const { state } = vi.hoisted(() => {
  const sharedState: MockState = {
    fixture: null,
    fixtureQueue: [],
    ctorArgs: [],
    callModelArgs: [],
    pausedGate: null,
    constructorThrows: null,
  };
  return { state: sharedState };
});

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const { createOpenRouterMockModule } = await import('../mock-openrouter.js');
  return { ...actual, ...createOpenRouterMockModule(state) };
});

vi.mock('../../../tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../../index.js';
import type { AgentCoreEvent, HookEvent, HookPayload } from '../../../index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ECHO_FIXTURE = resolve(REPO_ROOT, 'scripts/test-fixtures/mcp-stdio-echo.mjs');
const TEST_SESSION = 'integration-mcp-lifecycle-session';

interface RecordedHook {
  event: HookEvent;
  payload: HookPayload;
}

function happyPathFixture(): Fixture {
  return {
    name: 'mcp-happy-path',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      {
        type: 'yield',
        event: {
          type: 'response.output_item.done',
          outputIndex: 0,
          sequenceNumber: 1,
          item: {
            type: 'function_call',
            callId: 'mcp_call_1',
            name: 'echo__echo',
            arguments: JSON.stringify({ message: 'hello-mcp' }),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'echo__echo',
        input: { message: 'hello-mcp' },
        callId: 'mcp_call_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-mcp-happy',
      model: 'mock-model',
      usage: { cost: 0.001, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      output: [],
    },
  };
}

function noToolCallFixture(): Fixture {
  return {
    name: 'mcp-no-tool',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'no tools used' } },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-mcp-no-tool',
      model: 'mock-model',
      usage: { cost: 0.0001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output: [],
    },
  };
}

function abortableFixture(): Fixture {
  return {
    name: 'mcp-abort',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'starting...' } },
      { type: 'wait_until', signal: 'paused' },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-mcp-aborted',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      output: [],
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
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
});

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('integration: MCP lifecycle hooks', () => {
  it('happy path: spawns stdio server, fires McpServerStart with capabilities, dispatches tool, fires McpServerStop with reason:"closed"', async () => {
    state.fixture = happyPathFixture();
    const hooks: RecordedHook[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-mcp',
      sessionId: TEST_SESSION,
      prompt: 'use echo',
      tools: [], // No client tools — the bridge supplies echo__echo via MCP.
      mcpServers: [
        {
          transport: 'stdio',
          name: 'echo',
          command: process.execPath,
          args: [ECHO_FIXTURE],
          source: '<integration-test>',
        },
      ],
      onHook: (event, payload) => {
        hooks.push({ event, payload });
      },
    });
    const events = await collect(run);

    const start = hooks.find((h) => h.event === 'McpServerStart');
    expect(start, 'McpServerStart hook should fire').toBeDefined();
    const startPayload = start!.payload as Extract<HookPayload, { event: 'McpServerStart' }>;
    expect(startPayload.serverName).toBe('echo');
    expect(startPayload.transport).toBe('stdio');
    // The echo fixture registers 3 tools, 1 resource, 1 prompt.
    expect(startPayload.capabilities.tools).toBeGreaterThan(0);
    expect(startPayload.capabilities.resources).toBeGreaterThan(0);
    expect(startPayload.capabilities.prompts).toBeGreaterThan(0);

    const toolResult = events.find((e) => e.type === 'tool_result') as
      | Extract<AgentCoreEvent, { type: 'tool_result' }>
      | undefined;
    expect(toolResult, 'echo tool should be dispatched via the bridge').toBeDefined();
    expect(toolResult!.isError).toBe(false);
    // The MCP echo fixture echoes the message back as a CallToolResult.
    const output = JSON.stringify(toolResult!.output);
    expect(output).toContain('hello-mcp');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');

    const stop = hooks.find((h) => h.event === 'McpServerStop');
    expect(stop, 'McpServerStop hook should fire').toBeDefined();
    const stopPayload = stop!.payload as Extract<HookPayload, { event: 'McpServerStop' }>;
    expect(stopPayload.serverName).toBe('echo');
    expect(stopPayload.reason).toBe('closed');
    expect(stopPayload.durationMs).toBeGreaterThanOrEqual(0);

    // Stop event for the server fires before the agent's final Stop hook.
    const orderedNames = hooks.map((h) => h.event);
    const idxMcpStart = orderedNames.indexOf('McpServerStart');
    const idxMcpStop = orderedNames.indexOf('McpServerStop');
    const idxStop = orderedNames.indexOf('Stop');
    expect(idxMcpStart).toBeLessThan(idxMcpStop);
    expect(idxMcpStop).toBeLessThan(idxStop);
  }, 20000);

  it('error path: server that fails to spawn fires notify(warn, mcp_server_failed), McpServerStart does NOT fire, run still completes', async () => {
    state.fixture = noToolCallFixture();
    const hooks: RecordedHook[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-mcp',
      sessionId: TEST_SESSION,
      prompt: 'no mcp work',
      tools: [],
      mcpServers: [
        {
          transport: 'stdio',
          name: 'broken',
          command: process.execPath,
          args: [resolve(REPO_ROOT, 'scripts/test-fixtures/__does-not-exist__.mjs')],
          source: '<integration-test>',
        },
      ],
      onHook: (event, payload) => {
        hooks.push({ event, payload });
      },
    });
    const events = await collect(run);

    // McpServerStart must NOT fire for the failed handshake.
    const start = hooks.find((h) => h.event === 'McpServerStart');
    expect(start).toBeUndefined();

    // McpServerStop must NOT fire either (symmetric with no-start).
    const stop = hooks.find((h) => h.event === 'McpServerStop');
    expect(stop).toBeUndefined();

    // The existing failure path: notify(warn, mcp_server_failed) still fires.
    const failNotify = hooks.find(
      (h) =>
        h.event === 'Notification' &&
        (h.payload as Extract<HookPayload, { event: 'Notification' }>).message ===
          'mcp_server_failed',
    );
    expect(failNotify, 'mcp_server_failed Notification should fire').toBeDefined();
    const notifyPayload = failNotify!.payload as Extract<HookPayload, { event: 'Notification' }>;
    expect(notifyPayload.level).toBe('warn');
    expect((notifyPayload.context as { name?: string }).name).toBe('broken');

    // The run completes normally despite the MCP failure.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
  }, 20000);

  it('abort path: aborting mid-stream fires McpServerStop with reason:"aborted"', async () => {
    state.fixture = abortableFixture();
    state.pausedGate = createGate();
    const hooks: RecordedHook[] = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-mcp',
      sessionId: TEST_SESSION,
      prompt: 'abortable',
      tools: [],
      mcpServers: [
        {
          transport: 'stdio',
          name: 'echo',
          command: process.execPath,
          args: [ECHO_FIXTURE],
          source: '<integration-test>',
        },
      ],
      onHook: (event, payload) => {
        hooks.push({ event, payload });
      },
    });

    // Begin iterating; the mock fixture pauses at `wait_until: paused`. Once
    // we see the McpServerStart hook we know the server is live, and abort
    // unblocks the stream which then drains via the post-abort path.
    const iter = (async () => {
      const events: AgentCoreEvent[] = [];
      for await (const e of run) {
        events.push(e);
        if (e.type === 'text_delta') {
          // The stream has emitted text — bridge is up. Abort the run.
          run.abort();
          // Release the paused gate so the mock fixture can finish unwinding.
          state.pausedGate?.resolve();
        }
      }
      return events;
    })();
    const events = await iter;

    const start = hooks.find((h) => h.event === 'McpServerStart');
    expect(start, 'server should have started before the abort').toBeDefined();

    const stop = hooks.find((h) => h.event === 'McpServerStop');
    expect(stop, 'McpServerStop should fire on the abort teardown path').toBeDefined();
    const stopPayload = stop!.payload as Extract<HookPayload, { event: 'McpServerStop' }>;
    expect(stopPayload.serverName).toBe('echo');
    expect(stopPayload.reason).toBe('aborted');
    expect(stopPayload.durationMs).toBeGreaterThanOrEqual(0);

    const complete = events.find((e) => e.type === 'stream_complete') as Extract<
      AgentCoreEvent,
      { type: 'stream_complete' }
    >;
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
  }, 20000);
});
