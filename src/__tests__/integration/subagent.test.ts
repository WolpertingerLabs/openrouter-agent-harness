import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fixture, MockState } from './mock-openrouter.js';

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
  const { createOpenRouterMockModule } = await import('./mock-openrouter.js');
  return { ...actual, ...createOpenRouterMockModule(state) };
});

vi.mock('../../tools/server-tools.js', () => ({
  SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../index.js';
import type { AgentCoreEvent, HookEvent, HookPayload } from '../../index.js';

const PARENT_SESSION = 'integration-subagent-parent';

interface SpawnArgs {
  description: string;
  tools?: string[];
  instructions?: string;
  max_turns?: number;
  max_budget_usd?: number;
  effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
}

function parentFixtureCallingSubagent(spawnArgs: SpawnArgs): Fixture {
  return {
    name: 'parent-spawn',
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
            callId: 'spawn_call_1',
            name: 'spawn_subagent',
            arguments: JSON.stringify(spawnArgs),
          },
        },
      },
      {
        type: 'tool_execute',
        toolName: 'spawn_subagent',
        input: spawnArgs,
        callId: 'spawn_call_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-parent',
      model: 'mock-model',
      usage: { cost: 0.001, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      output: [],
    },
  };
}

function childFixtureSimpleText(): Fixture {
  return {
    name: 'child-simple',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'subagent ' } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'result' } },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-child',
      model: 'mock-model',
      usage: { cost: 0.0005, inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      output: [],
    },
  };
}

function childFixtureCallingDeniedTool(): Fixture {
  return {
    name: 'child-denied',
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
            callId: 'write_call_1',
            name: 'write_file',
            arguments: '{"path":"x.txt","content":"x"}',
          },
        },
      },
      // The child's tool pool was filtered to ['read_file'] only — the SDK
      // mock walks args.tools[] and reports "tool not found" because
      // write_file isn't in the filtered list. This is the denial path we
      // want to exercise.
      {
        type: 'tool_execute',
        toolName: 'write_file',
        input: { path: 'x.txt', content: 'x' },
        callId: 'write_call_1',
      },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: 'resp-child-denied',
      model: 'mock-model',
      usage: { cost: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output: [],
    },
  };
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
  await rm(join(process.cwd(), 'logs', PARENT_SESSION), { recursive: true, force: true });
  // Subagent session dirs are persisted under logsRoot too — clean up by
  // prefix. The integration tests use a deterministic parent session id, but
  // subagent ids are UUID-suffixed so we wildcard-clean.
  // (rm with force on a directory that doesn't exist is a no-op.)
});

describe('integration: spawn_subagent via OpenRouterAgentRun', () => {
  it('drives a parent → subagent flow end-to-end and surfaces a single tool_result with the subagent text', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'do the thing' }),
      childFixtureSimpleText(),
    ];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'use spawn_subagent',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    // Parent's event stream contains the spawn_subagent tool_call + tool_result
    // pair but NOT the subagent's session_started / turn_start / text_delta /
    // turn_end / stream_complete events (those are captured inside the runner).
    const parentTypes = events.map((e) => e.type);
    expect(parentTypes).toEqual([
      'session_started',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_end',
      'stream_complete',
    ]);

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.name).toBe('spawn_subagent');

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.isError).toBe(false);
    const output = toolResult?.output as {
      subagentSessionId: string;
      status: string;
      text: string;
      costUsd?: number;
    };
    expect(output.status).toBe('success');
    expect(output.text).toBe('subagent result');
    expect(output.subagentSessionId).toMatch(/^integration-subagent-parent:sub:/);
    expect(output.costUsd).toBeGreaterThan(0);

    // Hook stream: parent's SessionStart fires, parent's PreToolUse fires for
    // spawn_subagent, then SubagentStart, then the child's full hook stream
    // (Setup → SessionStart → SessionEnd → Stop), then SubagentEnd, then
    // parent's PostToolUse for spawn_subagent, then parent's SessionEnd / Stop.
    const eventNames = hookEvents.map((h) => h.event);
    expect(eventNames).toContain('SubagentStart');
    expect(eventNames).toContain('SubagentEnd');

    // SubagentStart and SubagentEnd are bracketing the child's session events.
    const startIdx = eventNames.indexOf('SubagentStart');
    const endIdx = eventNames.indexOf('SubagentEnd');
    expect(endIdx).toBeGreaterThan(startIdx);
    const between = eventNames.slice(startIdx + 1, endIdx);
    expect(between).toContain('SessionStart');
    expect(between).toContain('SessionEnd');

    // SubagentEnd carries the full result summary.
    const endHook = hookEvents.find((h) => h.event === 'SubagentEnd')!;
    if (endHook.payload.event !== 'SubagentEnd') throw new Error('expected SubagentEnd');
    expect(endHook.payload.parentSessionId).toBe(PARENT_SESSION);
    expect(endHook.payload.depth).toBe(1);
    expect(endHook.payload.result.status).toBe('success');
    expect(endHook.payload.result.text).toBe('subagent result');
    expect(endHook.payload.result.costUsd).toBeGreaterThan(0);

    // PostToolUse for spawn_subagent fires AFTER SubagentEnd.
    const postSpawn = hookEvents.findIndex(
      (h) =>
        h.event === 'PostToolUse' &&
        (h.payload as { toolName?: string }).toolName === 'spawn_subagent',
    );
    expect(postSpawn).toBeGreaterThan(endIdx);
  });

  it('filters the subagent tool pool to the whitelist supplied in `tools`', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'narrow scope', tools: ['read_file'] }),
      childFixtureCallingDeniedTool(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'use restricted subagent',
      enableSubagents: true,
      persistSession: false,
    });

    for await (const _ of parent) {
      void _;
    }

    // Inspect what the child's callModel was actually handed. The first
    // callModel was the parent's; the second was the subagent's.
    expect(state.callModelArgs.length).toBe(2);
    const childArgs = state.callModelArgs[1] as {
      tools: Array<{ function: { name: string } }>;
    };
    const childToolNames = childArgs.tools.map((t) => t.function.name).sort();
    // The whitelist passed only `read_file`; the subagent's pool should have
    // been filtered to that single name (no spawn_subagent, no write_file,
    // no monitor, …).
    expect(childToolNames).toEqual(['read_file']);
  });

  it('propagates onHook + lifecycle through nested subagents (sub spawns sub-sub)', async () => {
    // Parent spawns sub-1, sub-1 spawns sub-2, sub-2 returns simple text.
    // Three callModel invocations expected.
    const subSpawnArgs = { description: 'nested' };
    const grandSpawnArgs = { description: 'deepest' };

    const parentFixture: Fixture = {
      name: 'parent-nested',
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
              callId: 'p_spawn_1',
              name: 'spawn_subagent',
              arguments: JSON.stringify(subSpawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: subSpawnArgs,
          callId: 'p_spawn_1',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-p',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    const subFixture: Fixture = {
      name: 'sub-nested',
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
              callId: 's_spawn_1',
              name: 'spawn_subagent',
              arguments: JSON.stringify(grandSpawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: grandSpawnArgs,
          callId: 's_spawn_1',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-s',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    const grandFixture: Fixture = {
      name: 'grand',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        { type: 'yield', event: { type: 'response.output_text.delta', delta: 'deepest text' } },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-g',
        model: 'mock-model',
        usage: { cost: 0.0001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [parentFixture, subFixture, grandFixture];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'nested',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    for await (const _ of parent) void _;

    const startEvents = hookEvents.filter((h) => h.event === 'SubagentStart');
    const endEvents = hookEvents.filter((h) => h.event === 'SubagentEnd');
    // Two subagent levels were spawned: depth-1 (sub) and depth-2 (grand).
    expect(startEvents).toHaveLength(2);
    expect(endEvents).toHaveLength(2);

    const startDepths = startEvents.map((h) => (h.payload as { depth?: number }).depth).sort();
    expect(startDepths).toEqual([1, 2]);
  });

  it('inherits parent logger/baseUrl/onAskUserQuestion/onTasksChanged into the subagent run, and forwards child reason on error', async () => {
    const childThrowing: Fixture = {
      name: 'child-throws',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        { type: 'throw', message: 'mid-stream boom' },
      ],
      response: {
        id: 'resp-child-throws',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'will fail' }),
      childThrowing,
    ];

    const logCalls: Array<{ level: string; msg: string }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'exercise inheritance + reason path',
      enableSubagents: true,
      persistSession: false,
      baseUrl: 'https://example.test',
      logger: (level, msg) => logCalls.push({ level, msg }),
      onAskUserQuestion: async () => ({ questionId: 'q' }),
      onTasksChanged: () => undefined,
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    const output = toolResult?.output as { status: string; reason?: string };
    expect(output.status).toBe('error');
    expect(output.reason).toBe('mid-stream boom');

    // Subagent's OR client received the same baseUrl (serverURL) as parent.
    expect(state.ctorArgs).toHaveLength(2);
    const childCtor = state.ctorArgs[1] as { serverURL?: string };
    expect(childCtor.serverURL).toBe('https://example.test');
  });

  it('threads the parent run signal into the subagent OpenRouterAgentRun (cascade observable via SubagentEnd)', async () => {
    // Drive a normal parent-spawn-child happy path, then assert the
    // child's callModel arg structure picked up the composite signal — the
    // unit tests cover the moment-of-abort semantics; this guards the
    // wiring at the agent.ts level (signal threading + onHook inheritance).
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'observe signal' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'cascade-wiring',
      enableSubagents: true,
      persistSession: false,
    });
    for await (const _ of parent) void _;

    expect(state.ctorArgs).toHaveLength(2);
    // The child OR client receives the same apiKey + appTitle wiring (inherited).
    const parentCtor = state.ctorArgs[0] as { apiKey: string; appTitle: string };
    const childCtor = state.ctorArgs[1] as { apiKey: string; appTitle: string };
    expect(childCtor.apiKey).toBe(parentCtor.apiKey);
    expect(childCtor.appTitle).toBe(parentCtor.appTitle);

    // Subagent's session id is derived from the parent's.
    const childCallArgs = state.callModelArgs[1] as { sessionId: string };
    expect(childCallArgs.sessionId).toMatch(/^integration-subagent-parent:sub:/);
  });

  it('Phase 4.8: per-subagent permission_mode override does not leak into the parent (no-leak guard)', async () => {
    // Parent runs with `bypassPermissions` (write_file is allowed). It spawns
    // a subagent with `permission_mode: 'plan'` (write_file denied — read
    // only). After the subagent returns, the parent calls write_file itself
    // — that call MUST succeed, proving the override applied to the child's
    // ctor args only and never mutated the parent's resolved options.
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-no-leak-'));
    const parentWritePath = join(tmpDir, 'parent-wrote.txt');

    const spawnArgs = {
      description: 'try to write',
      permission_mode: 'plan' as const,
    };
    const parentFixture: Fixture = {
      name: 'parent-no-leak',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        // Step 1: spawn the subagent with the plan-mode override.
        {
          type: 'yield',
          event: {
            type: 'response.output_item.done',
            outputIndex: 0,
            sequenceNumber: 1,
            item: {
              type: 'function_call',
              callId: 'spawn_call',
              name: 'spawn_subagent',
              arguments: JSON.stringify(spawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: spawnArgs,
          callId: 'spawn_call',
        },
        // Step 2: after the subagent returns, the parent attempts its own
        // write_file. bypassPermissions on the parent must still be in
        // effect — the spawn-call override must NOT have leaked into the
        // parent's canUseTool gate.
        {
          type: 'yield',
          event: {
            type: 'response.output_item.done',
            outputIndex: 1,
            sequenceNumber: 2,
            item: {
              type: 'function_call',
              callId: 'parent_write_call',
              name: 'write_file',
              arguments: JSON.stringify({ path: parentWritePath, content: 'parent-ok' }),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'write_file',
          input: { path: parentWritePath, content: 'parent-ok' },
          callId: 'parent_write_call',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-parent',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    // The child fixture tries write_file. The child's resolved permission
    // mode is 'plan' (the override), so the canUseTool gate denies write.
    const childWritePath = join(tmpDir, 'child-should-be-blocked.txt');
    const childFixture: Fixture = {
      name: 'child-blocked',
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
              callId: 'child_write_call',
              name: 'write_file',
              arguments: JSON.stringify({ path: childWritePath, content: 'should-fail' }),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'write_file',
          input: { path: childWritePath, content: 'should-fail' },
          callId: 'child_write_call',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-child',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [parentFixture, childFixture];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'verify no leak',
      cwd: tmpDir,
      enableSubagents: true,
      permissionMode: 'bypassPermissions',
      persistSession: false,
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    // The parent's write_file MUST have succeeded — proving the override
    // never mutated the parent's permission gate.
    const parentWriteResult = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.callId === 'parent_write_call',
    );
    expect(parentWriteResult).toBeDefined();
    expect(parentWriteResult?.isError).toBe(false);
    const parentBytes = await readFile(parentWritePath, 'utf8');
    expect(parentBytes).toBe('parent-ok');

    // The subagent's write_file MUST have been denied by the plan-mode
    // override (canUseTool wrapper throws the synth-deny JSON, surfaced as
    // a tool_call_output with status incomplete → isError = true → the
    // runner captures it as a status: 'success' but with no text. The
    // spawn_subagent tool_result itself succeeds; what we verify is that
    // the child's denial is observable somewhere — the parent's
    // `tool_result` for spawn_subagent carries the captured summary).
    const spawnResult = events.find(
      (e): e is Extract<AgentCoreEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.callId === 'spawn_call',
    );
    expect(spawnResult).toBeDefined();
    expect(spawnResult?.isError).toBe(false);

    // Subagent's callModel got `permissionMode: 'plan'` even though the
    // parent's was `bypassPermissions`. The child's tool array is filtered
    // by the canUseTool wrapper at execute time; we assert here only that
    // the child ran and its callModel was issued (two callModel invocations
    // in total: parent + child).
    expect(state.callModelArgs.length).toBe(2);

    // The child's write_file attempt was denied by the plan-mode gate, so
    // its target file must NOT exist on disk.
    let childWroteAnyway = true;
    try {
      await readFile(childWritePath, 'utf8');
    } catch {
      childWroteAnyway = false;
    }
    expect(childWroteAnyway).toBe(false);

    // Cleanup the temp dir.
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Phase 4.8: per-subagent overrides omitted → child inherits parent allowedTools / disallowedTools / effort', async () => {
    // Parent sets ALL four Phase 4.8 inheritable knobs (permissionMode +
    // allowedTools + disallowedTools + effort). The spawn call omits every
    // override, so the child must inherit each one from the parent's
    // already-resolved opts. We don't have a direct handle on the child
    // OpenRouterAgentRun — it's constructed inside agent.ts's `runSubagent`
    // closure — so we capture the resolved opts by wrapping the prototype's
    // async-iterator method, which is invoked once per run (parent + child).
    // Asserting on the child's opts here exercises the resolveOptions
    // truthy spreads and the child-ctor truthy spreads for all four fields.
    type Iterable = { [Symbol.asyncIterator]: () => AsyncIterator<AgentCoreEvent> };
    const proto = OpenRouterAgentRun.prototype as unknown as Iterable & {
      opts: Record<string, unknown>;
    };
    const origIter = proto[Symbol.asyncIterator];
    const capturedOpts: Array<Record<string, unknown>> = [];
    proto[Symbol.asyncIterator] = function (this: { opts: Record<string, unknown> }) {
      capturedOpts.push({ ...this.opts });
      return origIter.call(this);
    };

    try {
      state.fixtureQueue = [
        parentFixtureCallingSubagent({ description: 'inherit test' }),
        childFixtureSimpleText(),
      ];

      const parent = new OpenRouterAgentRun({
        apiKey: 'sk-test',
        sessionId: PARENT_SESSION,
        prompt: 'verify inheritance',
        enableSubagents: true,
        persistSession: false,
        // `bypassPermissions` is chosen so the parent can issue the spawn
        // (the `plan`-mode read-only set excludes `spawn_subagent`, which
        // also isn't a valid `allowedTools` rule name → can't be allow-
        // listed there either). The exact mode is incidental — what
        // matters is that the same value flows verbatim into the child.
        permissionMode: 'bypassPermissions',
        allowedTools: ['read_file'],
        disallowedTools: ['Bash(rm *)'],
        effort: 'high',
      });

      for await (const _ev of parent) {
        void _ev;
      }

      // Both the parent and the child iterated through the spied
      // Symbol.asyncIterator → opts captured in spawn order.
      expect(capturedOpts).toHaveLength(2);
      const childOpts = capturedOpts[1]!;
      expect(childOpts.permissionMode).toBe('bypassPermissions');
      expect(childOpts.allowedTools).toEqual(['read_file']);
      expect(childOpts.disallowedTools).toEqual(['Bash(rm *)']);
      expect(childOpts.effort).toBe('high');
    } finally {
      proto[Symbol.asyncIterator] = origIter;
    }
  });

  it('child inherits streamStallTimeoutMs / toolTimeoutMs / modelContextWindows / tokenCounter from the parent', async () => {
    // Same prototype-spy capture as the Phase 4.8 inheritance test above —
    // the child run is constructed inside agent.ts's runSubagent closure, so
    // the resolved-opts snapshot is the cheapest observable. Covers the
    // child-ctor wiring for all four reliability/compaction-accounting knobs
    // (the two timeouts ride unconditionally as resolved numbers; the two
    // compaction options ride conditional spreads).
    type Iterable = { [Symbol.asyncIterator]: () => AsyncIterator<AgentCoreEvent> };
    const proto = OpenRouterAgentRun.prototype as unknown as Iterable & {
      opts: Record<string, unknown>;
    };
    const origIter = proto[Symbol.asyncIterator];
    const capturedOpts: Array<Record<string, unknown>> = [];
    proto[Symbol.asyncIterator] = function (this: { opts: Record<string, unknown> }) {
      capturedOpts.push({ ...this.opts });
      return origIter.call(this);
    };

    try {
      state.fixtureQueue = [
        parentFixtureCallingSubagent({ description: 'inherit reliability knobs' }),
        childFixtureSimpleText(),
      ];

      const tokenCounter = (s: string): number => s.length;
      const windows = { 'custom/model': 32_768 };
      const parent = new OpenRouterAgentRun({
        apiKey: 'sk-test',
        sessionId: PARENT_SESSION,
        prompt: 'verify reliability inheritance',
        enableSubagents: true,
        persistSession: false,
        streamStallTimeoutMs: 45_000,
        toolTimeoutMs: 5_000,
        modelContextWindows: windows,
        tokenCounter,
      });

      for await (const _ev of parent) {
        void _ev;
      }

      expect(capturedOpts).toHaveLength(2);
      const childOpts = capturedOpts[1]!;
      expect(childOpts.streamStallTimeoutMs).toBe(45_000);
      expect(childOpts.toolTimeoutMs).toBe(5_000);
      expect(childOpts.modelContextWindows).toEqual(windows);
      expect(childOpts.tokenCounter).toBe(tokenCounter);
    } finally {
      proto[Symbol.asyncIterator] = origIter;
    }
  });

  it('Phase 4.9: drives parallel spawn_subagents through the agent.ts wiring (lifecycle hooks fire for each child)', async () => {
    // Parent calls spawn_subagents (plural) with two specs. The agent.ts
    // wiring should register the plural tool when enableSubagents=true,
    // route each spec through the runSubagent closure, and fire
    // SubagentStart/SubagentEnd per child via the agent-wired emitter.
    const spawnArgs = {
      subagents: [{ description: 'parallel a' }, { description: 'parallel b' }],
    };
    const parentFixture: Fixture = {
      name: 'parent-parallel',
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
              callId: 'parallel_call_1',
              name: 'spawn_subagents',
              arguments: JSON.stringify(spawnArgs),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagents',
          input: spawnArgs,
          callId: 'parallel_call_1',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-parent-parallel',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [parentFixture, childFixtureSimpleText(), childFixtureSimpleText()];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'use spawn_subagents',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of parent) events.push(ev);

    // Parent stream has one tool_call (spawn_subagents) + one tool_result.
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.name).toBe('spawn_subagents');

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.isError).toBe(false);
    const output = toolResult?.output as {
      results: Array<{ status: string; subagentSessionId: string }>;
      aggregatedUsage: { usd: number };
    };
    expect(output.results).toHaveLength(2);
    expect(output.results.every((r) => r.status === 'success')).toBe(true);
    expect(output.aggregatedUsage.usd).toBeGreaterThan(0);

    // The agent-wired onSubagentLifecycle emitter fired SubagentStart +
    // SubagentEnd for both children (this is what covers the
    // spawnSubagents-config lifecycle arrow in agent.ts).
    const startCount = hookEvents.filter((h) => h.event === 'SubagentStart').length;
    const endCount = hookEvents.filter((h) => h.event === 'SubagentEnd').length;
    expect(startCount).toBe(2);
    expect(endCount).toBe(2);
  });

  it('Phase 4.9: a depth-1 subagent can call spawn_subagents (exercises the child-runner spawnSubagents wiring)', async () => {
    // Parent spawns one subagent via spawn_subagent. That subagent then
    // calls spawn_subagents (plural) with one spec. Three callModel
    // invocations expected: parent → sub-1 → sub-1's child. This covers
    // the runSubagent closure's own spawnSubagents-config emitter
    // (otherwise unreachable from depth-0 tests).
    const parentSpawn = { description: 'depth-1 sub' };
    const childParallelSpawn = { subagents: [{ description: 'depth-2 sub' }] };

    const parentFixture: Fixture = {
      name: 'parent-recursive',
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
              callId: 'p_spawn',
              name: 'spawn_subagent',
              arguments: JSON.stringify(parentSpawn),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagent',
          input: parentSpawn,
          callId: 'p_spawn',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-pr',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    const subFixture: Fixture = {
      name: 'sub-calls-parallel',
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
              callId: 's_par',
              name: 'spawn_subagents',
              arguments: JSON.stringify(childParallelSpawn),
            },
          },
        },
        {
          type: 'tool_execute',
          toolName: 'spawn_subagents',
          input: childParallelSpawn,
          callId: 's_par',
        },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-sub',
        model: 'mock-model',
        usage: { cost: 0.001, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    };

    state.fixtureQueue = [parentFixture, subFixture, childFixtureSimpleText()];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'recursive parallel',
      enableSubagents: true,
      persistSession: false,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    for await (const _ of parent) {
      void _;
    }

    // Three SubagentStart events expected: depth-1 (from parent's
    // spawn_subagent), depth-2 (from sub's spawn_subagents → one child).
    const starts = hookEvents.filter((h) => h.event === 'SubagentStart');
    expect(starts.length).toBe(2);
    const depths = starts
      .map((h) => (h.payload.event === 'SubagentStart' ? h.payload.depth : -1))
      .sort();
    expect(depths).toEqual([1, 2]);
  });

  it('Phase 5.4: per-spec `effort` rides the same inheritance rails as the rest of 4.8 — distinct on parent vs. child callModel request', async () => {
    // Parent runs with `effort: 'high'`, spawns a subagent that overrides
    // with `effort: 'low'`. Two callModel invocations expected; their
    // `reasoning.effort` must reflect each run's own value distinctly.
    const spawnArgs = { description: 'low-effort child', effort: 'low' as const };
    state.fixtureQueue = [parentFixtureCallingSubagent(spawnArgs), childFixtureSimpleText()];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'parent high, child low',
      enableSubagents: true,
      persistSession: false,
      effort: 'high',
    });

    for await (const _ of parent) void _;

    expect(state.callModelArgs).toHaveLength(2);
    const parentArgs = state.callModelArgs[0] as { reasoning?: { effort?: string } };
    const childArgs = state.callModelArgs[1] as { reasoning?: { effort?: string } };
    expect(parentArgs.reasoning).toEqual({ effort: 'high' });
    expect(childArgs.reasoning).toEqual({ effort: 'low' });
  });

  it('spawned subagent inherits parent `cacheControl` when the spawn spec omits it', async () => {
    // Parent runs with `cacheControl: { type: 'ephemeral' }`, spawns a
    // subagent that does not override. Both parent and child callModel
    // requests should carry the inherited cacheControl field verbatim.
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'inherit cache' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'parent caches, child inherits',
      enableSubagents: true,
      persistSession: false,
      cacheControl: { type: 'ephemeral' },
    });

    for await (const _ of parent) void _;

    expect(state.callModelArgs).toHaveLength(2);
    const parentArgs = state.callModelArgs[0] as {
      cacheControl?: { type: string; ttl?: string };
    };
    const childArgs = state.callModelArgs[1] as {
      cacheControl?: { type: string; ttl?: string };
    };
    expect(parentArgs.cacheControl).toEqual({ type: 'ephemeral' });
    expect(childArgs.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('parent without `cacheControl` → child callModel has NO `cacheControl` field', async () => {
    // Negative: nothing is set at the parent. Child should mirror — no
    // `cacheControl` key on either request body. Covers the `unset` arm of
    // the inheritance spread.
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'no cache anywhere' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'neither parent nor child set cacheControl',
      enableSubagents: true,
      persistSession: false,
    });

    for await (const _ of parent) void _;

    expect(state.callModelArgs).toHaveLength(2);
    const parentArgs = state.callModelArgs[0] as Record<string, unknown>;
    const childArgs = state.callModelArgs[1] as Record<string, unknown>;
    expect('cacheControl' in parentArgs).toBe(false);
    expect('cacheControl' in childArgs).toBe(false);
  });

  it('spawned subagent inherits parent `disableServerTools: true` — both OR ctors omit `hooks`', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'inherit server-tools opt-out' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'parent opts out, child inherits',
      enableSubagents: true,
      persistSession: false,
      disableServerTools: true,
    });

    for await (const _ of parent) void _;

    expect(state.ctorArgs.length).toBeGreaterThanOrEqual(2);
    const parentCtor = state.ctorArgs[0] as Record<string, unknown>;
    const childCtor = state.ctorArgs[1] as Record<string, unknown>;
    expect('hooks' in parentCtor).toBe(false);
    expect('hooks' in childCtor).toBe(false);
  });

  it('parent omits `disableServerTools` → both OR ctors receive `hooks` (default-on)', async () => {
    state.fixtureQueue = [
      parentFixtureCallingSubagent({ description: 'default server tools' }),
      childFixtureSimpleText(),
    ];

    const parent = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: PARENT_SESSION,
      prompt: 'default server-tools',
      enableSubagents: true,
      persistSession: false,
    });

    for await (const _ of parent) void _;

    expect(state.ctorArgs.length).toBeGreaterThanOrEqual(2);
    const parentCtor = state.ctorArgs[0] as Record<string, unknown>;
    const childCtor = state.ctorArgs[1] as Record<string, unknown>;
    expect('hooks' in parentCtor).toBe(true);
    expect('hooks' in childCtor).toBe(true);
  });
});
