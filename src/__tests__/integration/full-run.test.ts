import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGate, loadFixture, type MockState } from './mock-openrouter.js';

const { state } = vi.hoisted(() => {
  // Inlined to satisfy vi.mock hoisting — the factory cannot reach back to
  // module-scope identifiers that initialize after hoist time.
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

// Server-tool hooks would otherwise reach for an OpenRouter client at module
// load; stub them so the mocked OR module is the only path exercised here.
vi.mock('../../tools/server-tools.js', () => ({
  // Non-empty so the default (no `serverTools`) path resolves to a non-empty
  // list and registers the hook — the assertions below gate on hook presence.
  DEFAULT_SERVER_TOOLS: [{ type: 'openrouter:datetime' }],
  createServerToolsHooks: () => ({}),
}));

import { z } from 'zod/v4';
import { OpenRouterAgentRun, tool, createSdkMcpServer } from '../../index.js';
import type {
  AgentCoreEvent,
  CanUseTool,
  CanUseToolResult,
  HookEvent,
  HookPayload,
} from '../../index.js';

const TEST_SESSION = 'integration-full-run-session';

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

describe('integration: full run via OpenRouterAgentRun', () => {
  it('iterates a multi-turn run with a tool call end-to-end', async () => {
    state.fixture = loadFixture('multi-turn-with-tool');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('session_started');
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('text_delta');
    const turnEnds = events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(2);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
    expect(complete.reason).toBeUndefined();
    expect(complete.usage?.totalTokens).toBe(28);

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.output).toBe('echoed:hello');
    expect(toolResult.isError).toBe(false);

    // Lifecycle hooks fired in the expected order around the tool call:
    // Setup → SessionStart → ... PreToolUse/PostToolUse pairs ... → SessionEnd → Stop.
    const hookNames = hookEvents.map((h) => h.event);
    expect(hookNames[0]).toBe('Setup');
    expect(hookNames[1]).toBe('SessionStart');
    expect(hookNames).toContain('PreToolUse');
    expect(hookNames).toContain('PostToolUse');
    expect(hookNames.at(-2)).toBe('SessionEnd');
    expect(hookNames.at(-1)).toBe('Stop');
    const stop = hookEvents.find((h) => h.event === 'Stop')!.payload as Extract<
      HookPayload,
      { event: 'Stop' }
    >;
    expect(stop.status).toBe('success');
    expect(stop.reason).toBeUndefined();
  });

  it('runs the tool with substituted input when canUseTool returns updatedInput', async () => {
    state.fixture = loadFixture('single-tool-call');
    const decisions: Array<{ name: string; input: unknown }> = [];
    const canUseTool: CanUseTool = (name, input): CanUseToolResult => {
      decisions.push({ name, input });
      // Substitute the input — exercises the `updatedInput !== undefined` arm
      // of the permission wrapper so the wrapped execute receives the
      // override rather than the original input.
      return { behavior: 'allow', updatedInput: { value: 'rewritten' } };
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'gated allow',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      canUseTool,
    });
    const events = await collect(run);

    expect(decisions).toEqual([{ name: 'echo', input: { value: 'gated' } }]);
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:rewritten');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('surfaces a denial when canUseTool resolves deny', async () => {
    state.fixture = loadFixture('single-tool-call');
    const canUseTool: CanUseTool = (): CanUseToolResult => ({
      behavior: 'deny',
      reason: 'not allowed in test',
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'gated deny',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      canUseTool,
    });
    const events = await collect(run);

    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult.output));
    expect(parsed).toMatchObject({ denied: true, error: 'not allowed in test' });
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('yields stream_complete{status:error, reason:aborted} when abort() fires mid-stream', async () => {
    state.fixture = loadFixture('abort-mid-stream');
    const gate = createGate();
    state.pausedGate = gate;

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'will be aborted',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });

    const events: AgentCoreEvent[] = [];
    const iter = run[Symbol.asyncIterator]();
    // Drain until we've seen at least one text_delta, then abort and release.
    for (;;) {
      const next = await iter.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'text_delta') {
        run.abort();
        gate.resolve();
      }
      // Stop accumulating on stream_complete — the iterator should end after it.
      if (next.value.type === 'stream_complete') break;
    }

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // Post-abort events must be filtered out.
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toMatchObject({ content: 'starting...' });
  });

  it('emits error + stream_complete when the OpenRouter constructor throws', async () => {
    // No fixture needed — the constructor throws before callModel is invoked.
    state.constructorThrows = 'invalid API key';
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-bad',
      sessionId: TEST_SESSION,
      prompt: 'never gets there',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);
    const types = events.map((e) => e.type);

    // No session_started — construction failure short-circuits before that yield.
    expect(types).not.toContain('session_started');
    expect(types).toEqual(['error', 'stream_complete']);

    const error = events[0] as Extract<AgentCoreEvent, { type: 'error' }>;
    expect(error.message).toBe('invalid API key');
    expect(error.cause).toBeInstanceOf(Error);

    const complete = events[1] as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('invalid API key');

    // SessionStart hook never fires because session_started was never yielded.
    // Setup + SessionEnd + Stop still bracket the run (Stop fires regardless
    // of completion status, Setup fires before the OR-client construction).
    const hookNames = hookEvents.map((h) => h.event);
    expect(hookNames).not.toContain('SessionStart');
    expect(hookNames).toEqual(['Setup', 'SessionEnd', 'Stop']);
    const sessionEnd = hookEvents.find((h) => h.event === 'SessionEnd')!.payload as Extract<
      HookPayload,
      { event: 'SessionEnd' }
    >;
    expect(sessionEnd.status).toBe('error');
    expect(sessionEnd.usage).toBeNull();
    expect(sessionEnd.costUsd).toBe(0);
    const stop = hookEvents.find((h) => h.event === 'Stop')!.payload as Extract<
      HookPayload,
      { event: 'Stop' }
    >;
    expect(stop.status).toBe('error');
    expect(stop.reason).toBe('invalid API key');
  });

  it('catches an inner reject after abort and yields stream_complete{reason:aborted} via the catch arm', async () => {
    // Fixture invokes onTurnEnd (cost=0.05) and yields turn.end, then awaits
    // the paused gate. The test aborts + releases the gate, after which the
    // mock throws unconditionally — agent.ts's outer catch observes
    // signal.aborted=true and takes Block B (the aborted-inside-catch path).
    state.fixture = loadFixture('abort-then-throw');
    const gate = createGate();
    state.pausedGate = gate;
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'will be aborted then thrown',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    let aborted = false;
    for await (const event of run) {
      events.push(event);
      // Wait until the turn has fully closed (so onTurnEnd's cost tally lands
      // in totalCostUsd) before aborting + releasing the gate.
      if (!aborted && event.type === 'turn_end') {
        aborted = true;
        run.abort();
        gate.resolve();
      }
    }

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe('aborted');
    // Pre-abort tallies survive the catch — onTurnEnd ran before the throw.
    expect(complete.costUsd).toBeCloseTo(0.05);

    // SessionEnd hook carries matching status + pre-abort tallies.
    const sessionEnd = hookEvents.find((h) => h.event === 'SessionEnd')?.payload as
      | Extract<HookPayload, { event: 'SessionEnd' }>
      | undefined;
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd!.status).toBe('error');
    expect(sessionEnd!.costUsd).toBeCloseTo(0.05);
    // The catch arm runs before getResponse(), so finalUsage is still null.
    expect(sessionEnd!.usage).toBeNull();
  });

  it('surfaces a response.failed on the INITIAL turn as stream_complete{status:error} with the provider reason', async () => {
    // Regression for the initial-turn gap: the request opens 200 + SSE, then
    // the stream emits `response.failed` with no preceding tool call. Before
    // the fix this fell through the event loop and resolved as `success`.
    state.fixture = loadFixture('initial-turn-response-failed');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'generation fails after connect',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);

    const error = events.find((e) => e.type === 'error') as Extract<
      AgentCoreEvent,
      { type: 'error' }
    >;
    expect(error).toBeDefined();
    expect(error.message).toBe(
      'server_error: upstream provider returned an error: no endpoints available (resp-failed-initial mock-model)',
    );

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe(
      'server_error: upstream provider returned an error: no endpoints available (resp-failed-initial mock-model)',
    );

    const stop = hookEvents.find((h) => h.event === 'Stop')!.payload as Extract<
      HookPayload,
      { event: 'Stop' }
    >;
    expect(stop.status).toBe('error');
    expect(stop.reason).toBe(
      'server_error: upstream provider returned an error: no endpoints available (resp-failed-initial mock-model)',
    );
  });

  it('surfaces a response.failed on a FOLLOW-UP turn (after a tool call) as stream_complete{status:error}', async () => {
    // Regression guard ensuring both turns behave identically: a failure that
    // arrives after a tool call must also produce status:error, never success.
    state.fixture = loadFixture('followup-turn-response-failed');

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'follow-up generation fails',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events = await collect(run);

    // The tool result from the first turn still surfaced before the failure.
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:hello');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('error');
    expect(complete.reason).toBe(
      'rate_limit_exceeded: provider rate limit exceeded on follow-up turn (resp-failed-followup mock-model)',
    );
  });

  it('completes with null usage and zero cost when the response carries no usage block', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'no-usage path',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
    expect(complete.usage).toBeNull();
    expect(complete.costUsd).toBe(0);
  });

  it('synthesizes a hook callId when the SDK ctx omits toolCall.callId', async () => {
    state.fixture = loadFixture('tool-call-sdk-omits-ctx-callid');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'no-ctx-callid',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    await collect(run);

    const pre = hookEvents.find((h) => h.event === 'PreToolUse');
    const post = hookEvents.find((h) => h.event === 'PostToolUse');
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    const preId = (pre!.payload as { callId: string }).callId;
    const postId = (post!.payload as { callId: string }).callId;
    expect(preId).toBe(postId);
    expect(preId).not.toBe('call_x');
    expect(preId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('synth-denies bash with reason "requires approval" under permissionMode:"default"', async () => {
    state.fixture = loadFixture('single-run-command');
    // Stub bash tool — its execute should never be invoked because the
    // mode-derived canUseTool denies before the wrapper reaches the handler.
    const execSpy = vi.fn(async () => 'should not run');
    const bashStub = {
      type: 'function' as const,
      function: {
        name: 'bash',
        description: 'stub bash',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: execSpy,
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'try to run a command',
      tools: [bashStub] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      permissionMode: 'default',
    });
    const events = await collect(run);

    expect(execSpy).not.toHaveBeenCalled();
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult.output));
    expect(parsed).toEqual({ error: 'requires approval', denied: true });
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('allows bash when allowedTools "Bash(echo *)" matches the invocation', async () => {
    state.fixture = loadFixture('single-run-command-echo');
    const execSpy = vi.fn(async () => 'ok');
    const bashStub = {
      type: 'function' as const,
      function: {
        name: 'bash',
        description: 'stub bash',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: execSpy,
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'echo something',
      tools: [bashStub] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      allowedTools: ['Bash(echo *)'],
    });
    const events = await collect(run);

    expect(execSpy).toHaveBeenCalledWith({ command: 'echo hello' }, expect.anything());
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('ok');
  });

  it('denies bash when allowedTools does not cover the invocation (no fallback gate)', async () => {
    state.fixture = loadFixture('single-run-command-echo');
    const execSpy = vi.fn(async () => 'should not run');
    const bashStub = {
      type: 'function' as const,
      function: {
        name: 'bash',
        description: 'stub bash',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: execSpy,
      },
    };

    // allowedTools restricted to `npm *` only — `echo hello` should not match,
    // and without disallowedTools / permissionMode we fall through to allow.
    // To exercise a deny path we instead use disallowedTools for `echo *`.
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'echo something',
      tools: [bashStub] as unknown as ConstructorParameters<typeof OpenRouterAgentRun>[0]['tools'],
      disallowedTools: ['Bash(echo *)'],
    });
    const events = await collect(run);

    expect(execSpy).not.toHaveBeenCalled();
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(true);
    const parsed = JSON.parse(String(toolResult.output));
    expect(parsed).toMatchObject({ denied: true });
    expect(parsed.error).toMatch(/disallowedTools/);
  });

  it('plan mode: denies write_file with plan-specific reason, allows read_file, completes successfully', async () => {
    state.fixture = loadFixture('plan-mode-write-then-read');
    const writeExecSpy = vi.fn(async () => 'written ok');
    const readExecSpy = vi.fn(async () => 'file contents');
    const writeStub = {
      type: 'function' as const,
      function: {
        name: 'write_file',
        description: 'stub write_file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
        execute: writeExecSpy,
      },
    };
    const readStub = {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: 'stub read_file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: readExecSpy,
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'in plan mode, please write a file',
      tools: [writeStub, readStub] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      permissionMode: 'plan',
    });
    const events = await collect(run);

    // write_file must never reach its handler under plan mode.
    expect(writeExecSpy).not.toHaveBeenCalled();
    // read_file is read-only and passes the plan gate normally.
    expect(readExecSpy).toHaveBeenCalledWith({ path: 'existing.txt' }, expect.anything());

    const toolResults = events.filter((e) => e.type === 'tool_result') as Array<
      Extract<AgentCoreEvent, { type: 'tool_result' }>
    >;
    expect(toolResults.length).toBe(2);
    const writeResult = toolResults.find((r) => r.callId === 'call_write');
    const readResult = toolResults.find((r) => r.callId === 'call_read');
    expect(writeResult).toBeDefined();
    expect(readResult).toBeDefined();

    expect(writeResult!.isError).toBe(true);
    const parsedWrite = JSON.parse(String(writeResult!.output));
    expect(parsedWrite).toEqual({
      error: 'plan mode: read-only — propose edits in your reply',
      denied: true,
    });

    expect(readResult!.isError).toBe(false);
    expect(readResult!.output).toBe('file contents');

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
  });

  it('composes discovered CLAUDE.md into the callModel instructions when settingSources is set', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const workdir = await mkdtemp(join(tmpdir(), 'integration-settingsources-'));
    try {
      // Drop a project CLAUDE.md and a .git so the project source resolves
      // deterministically without depending on the host environment.
      await writeFile(join(workdir, 'CLAUDE.md'), 'PROJECT-CONTEXT-LINE', 'utf8');
      await mkdir(join(workdir, '.git'), { recursive: true });
      await writeFile(join(workdir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int-test',
        sessionId: TEST_SESSION,
        prompt: 'discover context',
        cwd: workdir,
        logsRoot: join(workdir, 'logs'),
        instructions: 'INSTRUCTIONS_BLOCK',
        settingSources: ['project'],
        tools: [echoTool()] as unknown as ConstructorParameters<
          typeof OpenRouterAgentRun
        >[0]['tools'],
      });
      await collect(run);

      const callArgs = state.callModelArgs[0] as { instructions?: string };
      expect(callArgs.instructions).toBe('PROJECT-CONTEXT-LINE\n\nINSTRUCTIONS_BLOCK');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('reports stream_complete{status:max_turns} when the turn count reaches maxTurns', async () => {
    state.fixture = loadFixture('max-turns');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'cap-the-turns',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      maxTurns: 2,
    });
    const events = await collect(run);
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_turns');
  });

  it('records the full hook order Setup → SessionStart → Pre/Post pairs → SessionEnd → Stop with ctx.notify interleaved', async () => {
    state.fixture = loadFixture('multi-turn-with-tool');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];

    // Custom tool that fires a Notification through ctx.notify while it runs.
    // Validates the wrapper-injected ctx.notify is reachable from user code.
    const notifyingEcho = {
      type: 'function' as const,
      function: {
        name: 'echo',
        description: 'echoes input and emits a Notification',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        execute: async (
          input: { value: string },
          ctx?: { notify?: (l: string, m: string, c?: unknown) => Promise<void> },
        ) => {
          await ctx?.notify?.('info', 'echoing', { value: input.value });
          return `echoed:${input.value}`;
        },
      },
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'do work',
      tools: [notifyingEcho] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    await collect(run);

    const names = hookEvents.map((h) => h.event);
    // Strict ordering: Setup first, SessionStart second; SessionEnd then Stop
    // are the last two events. Pre/Post pairs and any Notifications fall in
    // between. Notification appears exactly once (one tool call → one notify).
    expect(names[0]).toBe('Setup');
    expect(names[1]).toBe('SessionStart');
    expect(names.at(-2)).toBe('SessionEnd');
    expect(names.at(-1)).toBe('Stop');
    expect(names).toContain('PreToolUse');
    expect(names).toContain('PostToolUse');

    const notifications = hookEvents.filter((h) => h.event === 'Notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload).toEqual({
      event: 'Notification',
      level: 'info',
      message: 'echoing',
      context: { value: 'hello' },
    });

    // Pre/Post pair is between Setup-bracket and SessionEnd-bracket.
    const preIdx = names.indexOf('PreToolUse');
    const postIdx = names.indexOf('PostToolUse');
    const notifyIdx = names.indexOf('Notification');
    const sessionEndIdx = names.indexOf('SessionEnd');
    expect(preIdx).toBeGreaterThan(1);
    expect(postIdx).toBeGreaterThan(preIdx);
    expect(notifyIdx).toBeGreaterThan(preIdx);
    expect(notifyIdx).toBeLessThan(postIdx);
    expect(sessionEndIdx).toBeGreaterThan(postIdx);

    const stop = hookEvents.at(-1)!.payload as Extract<HookPayload, { event: 'Stop' }>;
    expect(stop.status).toBe('success');
    expect(stop.reason).toBeUndefined();
  });

  it('routes ask_user_question through onAskUserQuestion and fires the Notification hook', async () => {
    state.fixture = loadFixture('ask-user-question');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const askSpy = vi.fn(async (req: { questionId: string; options: Array<{ id: string }> }) => ({
      questionId: req.questionId,
      selectedOptionId: req.options[1].id,
    }));

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'need clarification',
      // Default tool bundle so the built-in `ask_user_question` is wired.
      onAskUserQuestion: askSpy as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['onAskUserQuestion'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);

    // The host callback received a request with id 'a'/'b' on the options.
    expect(askSpy).toHaveBeenCalledTimes(1);
    const requestArg = askSpy.mock.calls[0][0] as unknown as {
      question: string;
      options: Array<{ id: string; label: string }>;
    };
    expect(requestArg.question).toBe('Which framework?');
    expect(requestArg.options).toEqual([
      { id: 'a', label: 'React' },
      { id: 'b', label: 'Vue' },
    ]);

    // The tool result echoed the chosen option's id + label back to the model.
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toMatchObject({ selectedOptionId: 'b', label: 'Vue' });

    // The Notification hook fired with the request payload (level=info,
    // message='ask_user_question'). One notification per call.
    const notifications = hookEvents.filter((h) => h.event === 'Notification');
    expect(notifications).toHaveLength(1);
    const notify = notifications[0].payload as Extract<HookPayload, { event: 'Notification' }>;
    expect(notify.level).toBe('info');
    expect(notify.message).toBe('ask_user_question');
    expect(notify.context).toMatchObject({
      question: 'Which framework?',
      options: [
        { id: 'a', label: 'React' },
        { id: 'b', label: 'Vue' },
      ],
    });

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('threads task_create / task_update through onTasksChanged and Notification with a shared list', async () => {
    state.fixture = loadFixture('task-create-and-update');
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const onTasksChanged = vi.fn();

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'organize the work',
      // Default tool bundle so the built-in task_create / task_update wire up.
      onTasksChanged: onTasksChanged as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['onTasksChanged'],
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });
    const events = await collect(run);

    // Both tool calls returned a UUID id (no error path hit).
    const toolResults = events.filter((e) => e.type === 'tool_result') as Array<
      Extract<AgentCoreEvent, { type: 'tool_result' }>
    >;
    expect(toolResults).toHaveLength(2);
    for (const r of toolResults) {
      expect(r.isError).toBe(false);
      expect(r.output).toMatchObject({ id: expect.any(String) });
    }

    // onTasksChanged fired once per create — last invocation carries both tasks.
    expect(onTasksChanged).toHaveBeenCalledTimes(2);
    const finalTasks = onTasksChanged.mock.calls.at(-1)![0] as Array<{
      content: string;
      state: string;
    }>;
    expect(finalTasks).toMatchObject([
      { content: 'Write the docs', state: 'pending', activeForm: 'Writing the docs' },
      { content: 'Run the tests', state: 'pending' },
    ]);

    // Notification hook fired once per mutation with the same shape.
    const notifications = hookEvents.filter(
      (h) =>
        h.event === 'Notification' &&
        (h.payload as Extract<HookPayload, { event: 'Notification' }>).message === 'tasks_changed',
    );
    expect(notifications).toHaveLength(2);
    const lastNotify = notifications.at(-1)!.payload as Extract<
      HookPayload,
      { event: 'Notification' }
    >;
    expect(lastNotify.level).toBe('info');
    expect(lastNotify.context).toEqual({ tasks: finalTasks });

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('runs a Zod-schema custom tool built via tool() / createSdkMcpServer end-to-end', async () => {
    state.fixture = loadFixture('single-tool-call');

    const execSpy = vi.fn(async (input: { value: string }) => `echoed:${input.value}`);
    const echo = tool({
      name: 'echo',
      description: 'returns the value field of its input',
      inputSchema: z.object({ value: z.string() }),
      execute: execSpy,
    });
    const server = createSdkMcpServer({
      name: 'demo-server',
      version: '0.0.1',
      tools: [echo],
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'run a custom tool',
      tools: server.tools,
    });
    const events = await collect(run);

    // The fixture's input ({ value: 'gated' }) passes Zod validation and is
    // handed to the user-supplied execute verbatim.
    expect(execSpy).toHaveBeenCalledWith({ value: 'gated' }, expect.anything());
    const toolResult = events.find((e) => e.type === 'tool_result') as Extract<
      AgentCoreEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.output).toBe('echoed:gated');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');
  });

  it('Phase 5.4: forwards `effort` into the callModel request as `reasoning: { effort }`', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'effort flows through',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      effort: 'high',
    });
    await collect(run);

    expect(state.callModelArgs).toHaveLength(1);
    const callArgs = state.callModelArgs[0] as { reasoning?: { effort?: string } };
    expect(callArgs.reasoning).toEqual({ effort: 'high' });
  });

  it('Phase 5.4: omitted `effort` → callModel request has NO `reasoning` field (negative assertion)', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'effort omitted',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    await collect(run);

    expect(state.callModelArgs).toHaveLength(1);
    const callArgs = state.callModelArgs[0] as Record<string, unknown>;
    // Hard negative — the field must not be present at all, not just be
    // `{ effort: undefined }` (per Phase 5.4 invariant: no
    // `{ reasoning: { effort: undefined } }` payloads).
    expect('reasoning' in callArgs).toBe(false);
  });

  it('forwards `cacheControl` into the callModel request as a top-level field', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'cacheControl flows through',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      cacheControl: { type: 'ephemeral' },
    });
    await collect(run);

    expect(state.callModelArgs).toHaveLength(1);
    const callArgs = state.callModelArgs[0] as {
      cacheControl?: { type: string; ttl?: string };
    };
    expect(callArgs.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('omitted `cacheControl` → callModel request has NO `cacheControl` field (negative assertion)', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'cacheControl omitted',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    await collect(run);

    expect(state.callModelArgs).toHaveLength(1);
    const callArgs = state.callModelArgs[0] as Record<string, unknown>;
    // Hard negative — the field must be absent (not present-with-undefined).
    expect('cacheControl' in callArgs).toBe(false);
  });

  it('forwards `cacheControl` with a `ttl` field verbatim', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'cacheControl with ttl',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      cacheControl: { type: 'ephemeral', ttl: '5m' },
    });
    await collect(run);

    expect(state.callModelArgs).toHaveLength(1);
    const callArgs = state.callModelArgs[0] as {
      cacheControl?: { type: string; ttl?: string };
    };
    expect(callArgs.cacheControl).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('default (no `serverTools`) → OR ctor receives `hooks` (server tools active)', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'server tools default',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
    });
    await collect(run);

    expect(state.ctorArgs.length).toBeGreaterThan(0);
    const ctorArgs = state.ctorArgs[0] as Record<string, unknown>;
    expect('hooks' in ctorArgs).toBe(true);
  });

  it('`serverTools: []` → OR ctor receives NO `hooks` key (server tools suppressed)', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'server tools disabled',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      serverTools: [],
    });
    await collect(run);

    expect(state.ctorArgs.length).toBeGreaterThan(0);
    const ctorArgs = state.ctorArgs[0] as Record<string, unknown>;
    // Hard negative — the field must be absent (not present-with-undefined).
    expect('hooks' in ctorArgs).toBe(false);
  });

  it('custom `serverTools` → OR ctor receives `hooks` (server tools active)', async () => {
    state.fixture = loadFixture('single-turn-no-usage');
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-int-test',
      sessionId: TEST_SESSION,
      prompt: 'server tools customized',
      tools: [echoTool()] as unknown as ConstructorParameters<
        typeof OpenRouterAgentRun
      >[0]['tools'],
      serverTools: [{ type: 'openrouter:web_search', engine: 'exa' }],
    });
    await collect(run);

    expect(state.ctorArgs.length).toBeGreaterThan(0);
    const ctorArgs = state.ctorArgs[0] as Record<string, unknown>;
    expect('hooks' in ctorArgs).toBe(true);
  });
});
