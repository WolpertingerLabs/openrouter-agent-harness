// NOTE: A cosmetic `close timed out after 10000ms` message can appear AFTER
// `Tests closed successfully` — same root cause as the other MCP integration
// suites (the SDK's stdio transport cleanup outliving vitest's pool-close).
// Exit code is 0 and tests pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { type Fixture, type MockState } from '../mock-openrouter.js';

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
const TEST_SESSION = 'integration-tool-search-session';

interface RecordedHook {
  event: HookEvent;
  payload: HookPayload;
}

/**
 * Fixture that asks the model to search the catalog, then load + invoke a
 * specific MCP tool — all within a single `callModel` cycle. Step order:
 *
 * 1. emit one `tool_call` for `tool_search` (returns matches incl. echo__echo)
 * 2. `tool_execute` for `tool_search` — runs our search factory against the
 *    live bridge catalog
 * 3. emit one `tool_call` for `tool_load` to register `echo__echo`
 * 4. `tool_execute` for `tool_load` — pushes the wrapped echo tool onto the
 *    live tools array AND fires Notification(level:info, tool_loaded)
 * 5. emit one `tool_call` for the newly-loaded `echo__echo`
 * 6. `tool_execute` for `echo__echo` — proves the load worked mid-cycle (the
 *    mock looks up tools off the same `args.tools` ref that we mutated)
 * 7. `turn.end`
 */
function searchThenLoadThenInvokeFixture(): Fixture {
  return {
    name: 'tool-search-flow',
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
            callId: 'search_1',
            name: 'tool_search',
            arguments: JSON.stringify({ query: 'echo' }),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'tool_search',
        input: { query: 'echo' },
        callId: 'search_1',
      },
      {
        type: 'yield',
        event: {
          type: 'response.output_item.done',
          outputIndex: 1,
          sequenceNumber: 2,
          item: {
            type: 'function_call',
            callId: 'load_1',
            name: 'tool_load',
            arguments: JSON.stringify({ names: ['echo__echo'] }),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'tool_load',
        input: { names: ['echo__echo'] },
        callId: 'load_1',
      },
      {
        type: 'yield',
        event: {
          type: 'response.output_item.done',
          outputIndex: 2,
          sequenceNumber: 3,
          item: {
            type: 'function_call',
            callId: 'invoke_1',
            name: 'echo__echo',
            arguments: JSON.stringify({ message: 'after-load' }),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'echo__echo',
        input: { message: 'after-load' },
        callId: 'invoke_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-tool-search-flow',
      model: 'mock-model',
      usage: { cost: 0.001, inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      output: [],
    },
  };
}

/**
 * Fixture for the back-compat path — `enableToolSearch` is OFF, so the
 * bridge's MCP tools are visible up front and the model calls `echo__echo`
 * directly without any search/load step.
 */
function directInvokeFixture(): Fixture {
  return {
    name: 'tool-search-disabled',
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
            callId: 'direct_1',
            name: 'echo__echo',
            arguments: JSON.stringify({ message: 'no-search' }),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'echo__echo',
        input: { message: 'no-search' },
        callId: 'direct_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-direct',
      model: 'mock-model',
      usage: { cost: 0.0005, inputTokens: 5, outputTokens: 1, totalTokens: 6 },
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

describe('integration: tool_search + tool_load with a real MCP bridge', () => {
  it('hides bridge tools until tool_load, then registers + dispatches them mid-cycle', async () => {
    state.fixture = searchThenLoadThenInvokeFixture();
    const hooks: RecordedHook[] = [];
    // The tools array passed to callModel is mutated in-place by tool_load
    // (that's the whole mid-cycle-registration mechanism). To assert on the
    // INITIAL state we must snapshot the names at the very first PreToolUse —
    // that fires for `tool_search`, before `tool_load` has had a chance to
    // push `echo__echo`. A post-run read of `state.callModelArgs[0].tools`
    // would see the mutated array and miss the hidden-tool guarantee.
    let initialToolNames: string[] | null = null;
    let postLoadToolNames: string[] | null = null;

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-tool-search',
      sessionId: TEST_SESSION,
      prompt: 'discover and use echo',
      enableToolSearch: true,
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
        if (event === 'PreToolUse') {
          const first = state.callModelArgs[0] as
            | { tools: Array<{ function: { name: string } }> }
            | undefined;
          if (!first) return;
          const names = first.tools.map((t) => t.function.name);
          if (initialToolNames === null) {
            initialToolNames = names;
          }
          const pre = payload as Extract<HookPayload, { event: 'PreToolUse' }>;
          if (pre.toolName === 'echo__echo') {
            postLoadToolNames = names;
          }
        }
      },
    });

    const events = await collect(run);

    expect(state.callModelArgs.length).toBeGreaterThan(0);
    // Snapshot taken at first PreToolUse (tool_search) — echo__echo MUST be
    // hidden, tool_search and tool_load MUST be present.
    expect(initialToolNames, 'PreToolUse fired at least once').not.toBeNull();
    expect(initialToolNames!).toContain('tool_search');
    expect(initialToolNames!).toContain('tool_load');
    expect(initialToolNames!).not.toContain('echo__echo');

    // The tool_search result must have surfaced echo__echo with prefixed name.
    const searchResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'search_1',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(searchResult).toBeDefined();
    const matches = (searchResult.output as { matches: Array<{ name: string }> }).matches;
    expect(matches.some((m) => m.name === 'echo__echo')).toBe(true);

    // The tool_load result must have echo__echo in `loaded`.
    const loadResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'load_1',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(loadResult).toBeDefined();
    expect((loadResult.output as { loaded: string[] }).loaded).toContain('echo__echo');

    // After load, the tools array passed to callModel MUST now include
    // echo__echo (the mock holds a live reference to `args.tools` — our push
    // is visible to subsequent tool lookups). This is the proof that
    // mid-cycle registration works.
    expect(postLoadToolNames, 'PreToolUse fired for echo__echo').not.toBeNull();
    expect(postLoadToolNames!).toContain('echo__echo');

    // The actual invocation of echo__echo after load must succeed and return
    // the echoed message.
    const invokeResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'invoke_1',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(invokeResult).toBeDefined();
    expect(invokeResult.isError).toBe(false);
    expect(JSON.stringify(invokeResult.output)).toContain('after-load');

    // A `tool_loaded` Notification must have fired with the prefixed name
    // and originating server.
    const toolLoadedNotify = hooks.find(
      (h) =>
        h.event === 'Notification' &&
        (h.payload as Extract<HookPayload, { event: 'Notification' }>).message === 'tool_loaded',
    );
    expect(toolLoadedNotify, 'tool_loaded Notification must fire').toBeDefined();
    const notifyPayload = toolLoadedNotify!.payload as Extract<
      HookPayload,
      { event: 'Notification' }
    >;
    expect(notifyPayload.level).toBe('info');
    expect(notifyPayload.context).toEqual({ name: 'echo__echo', server: 'echo' });

    // Run completes cleanly.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
  }, 20000);

  it('back-compat: with enableToolSearch=false, bridge tools are visible up front', async () => {
    state.fixture = directInvokeFixture();

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-tool-search',
      sessionId: TEST_SESSION,
      prompt: 'use echo directly',
      // enableToolSearch omitted (defaults to false).
      mcpServers: [
        {
          transport: 'stdio',
          name: 'echo',
          command: process.execPath,
          args: [ECHO_FIXTURE],
          source: '<integration-test>',
        },
      ],
    });

    const events = await collect(run);

    expect(state.callModelArgs.length).toBeGreaterThan(0);
    const firstCall = state.callModelArgs[0] as {
      tools: Array<{ function: { name: string } }>;
    };
    const names = firstCall.tools.map((t) => t.function.name);
    expect(names).toContain('echo__echo');
    expect(names).not.toContain('tool_search');
    expect(names).not.toContain('tool_load');

    const invokeResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'direct_1',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(invokeResult).toBeDefined();
    expect(invokeResult.isError).toBe(false);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
  }, 20000);

  it('tool_load with no MCP servers configured reports notFound for every requested name', async () => {
    // Covers the `this.#mcpBridge?.catalog ?? []` right-hand fallback inside
    // the toolLoad factory's getCatalog closure — the bridge is undefined
    // because no servers were configured, so the catalog is empty and every
    // requested name lands in `notFound`. The branch is symmetric to the
    // tool_search empty-catalog path but reaches a different closure.
    state.fixture = {
      name: 'load-empty-catalog',
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
              callId: 'load_empty',
              name: 'tool_load',
              arguments: JSON.stringify({ names: ['nothing__here'] }),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'tool_load',
          input: { names: ['nothing__here'] },
          callId: 'load_empty',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-load-empty',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        output: [],
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-tool-search',
      sessionId: TEST_SESSION,
      prompt: 'load but no bridge',
      enableToolSearch: true,
    });

    const events = await collect(run);
    const loadResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'load_empty',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(loadResult).toBeDefined();
    expect((loadResult.output as { notFound: string[] }).notFound).toEqual(['nothing__here']);
  }, 20000);

  it('tool_search returns an "empty catalog" note when no MCP servers are configured', async () => {
    // Use a single search fixture; no MCP servers, so the catalog is empty
    // and the search tool resolves with an empty matches list + helpful note.
    state.fixture = {
      name: 'empty-catalog',
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
              callId: 'search_empty',
              name: 'tool_search',
              arguments: JSON.stringify({ query: 'anything' }),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'tool_search',
          input: { query: 'anything' },
          callId: 'search_empty',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-empty',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        output: [],
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-tool-search',
      sessionId: TEST_SESSION,
      prompt: 'search but no servers',
      enableToolSearch: true,
      // No `mcpServers` configured.
    });

    const events = await collect(run);

    const searchResult = events.find(
      (e) => e.type === 'tool_result' && e.callId === 'search_empty',
    ) as Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expect(searchResult).toBeDefined();
    const out = searchResult.output as { matches: unknown[]; note?: string };
    expect(out.matches).toEqual([]);
    expect(out.note).toMatch(/no mcp tools/i);
  }, 20000);
});
