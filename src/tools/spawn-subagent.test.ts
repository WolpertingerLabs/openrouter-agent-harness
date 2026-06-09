import { describe, it, expect, vi } from 'vitest';
import {
  spawnSubagentTool,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type SpawnSubagentToolOptions,
  type SpawnSubagentToolResult,
  type SubagentRunConfig,
  type SubagentRunResult,
  type SubagentRunner,
  type SubagentLifecycleEmitter,
} from './spawn-subagent.js';
import type { HookEvent, HookPayload } from '../events.js';

interface SpawnInput {
  description: string;
  tools?: string[];
  instructions?: string;
  max_turns?: number;
  max_budget_usd?: number;
  model?: string;
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowed_tools?: string[];
  disallowed_tools?: string[];
  effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
}

type ExecuteFn = (input: SpawnInput, ctx?: unknown) => Promise<SpawnSubagentToolResult>;

function makeTool(
  opts: Partial<SpawnSubagentToolOptions> & { runSubagent: SubagentRunner },
  ctx: Parameters<typeof spawnSubagentTool>[1] = { cwd: '.' },
) {
  const full: SpawnSubagentToolOptions = {
    parentSessionId: 'parent-session',
    ...opts,
  };
  const t = spawnSubagentTool(full, ctx);
  return {
    tool: t,
    execute: t.function.execute as ExecuteFn,
  };
}

function makeRunnerOk(summary: Partial<SubagentRunResult> = {}): SubagentRunner {
  return vi.fn<SubagentRunner>(async () => ({
    status: 'success',
    text: 'subagent finished',
    costUsd: 0.0042,
    durationMs: 123,
    ...summary,
  }));
}

function captureLifecycle(): {
  emitter: SubagentLifecycleEmitter;
  events: Array<{ event: HookEvent; payload: HookPayload }>;
} {
  const events: Array<{ event: HookEvent; payload: HookPayload }> = [];
  const emitter: SubagentLifecycleEmitter = async (event, payload) => {
    events.push({ event, payload });
  };
  return { emitter, events };
}

describe('spawn_subagent tool — schema + identity', () => {
  it('exposes the correct name and a description mentioning delegation', () => {
    const { tool } = makeTool({ runSubagent: makeRunnerOk() });
    expect(tool.function.name).toBe('spawn_subagent');
    expect(tool.function.description).toMatch(/delegate|subagent|child/i);
  });

  it('DEFAULT_MAX_SUBAGENT_DEPTH is 3', () => {
    expect(DEFAULT_MAX_SUBAGENT_DEPTH).toBe(3);
  });
});

describe('spawn_subagent tool — happy path', () => {
  it('drives the runner with derived sessionId and forwards prompt + overrides', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({
      parentSessionId: 'parent-abc',
      runSubagent: runner,
    });

    const result = await execute({
      description: 'investigate the bug',
      instructions: 'be terse',
      max_turns: 3,
      max_budget_usd: 0.5,
      tools: ['read_file', 'grep_files'],
    });

    expect(runner).toHaveBeenCalledTimes(1);
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.sessionId).toMatch(/^parent-abc:sub:[0-9a-f-]{36}$/);
    expect(config.prompt).toBe('investigate the bug');
    expect(config.instructions).toBe('be terse');
    expect(config.maxTurns).toBe(3);
    expect(config.maxBudgetUsd).toBe(0.5);
    expect(config.toolNames).toEqual(['read_file', 'grep_files']);
    expect(config.depth).toBe(1);
    expect(config.signal).toBeInstanceOf(AbortSignal);

    expect(result.subagentSessionId).toBe(config.sessionId);
    expect(result.status).toBe('success');
    expect(result.text).toBe('subagent finished');
    expect(result.costUsd).toBe(0.0042);
    expect(result.durationMs).toBe(123);
    expect(result.error).toBeUndefined();
  });

  it('omits optional fields from runner config when caller omits them', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });

    await execute({ description: 'do thing' });

    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.instructions).toBeUndefined();
    expect(config.maxTurns).toBeUndefined();
    expect(config.maxBudgetUsd).toBeUndefined();
    expect(config.toolNames).toBeUndefined();
  });

  it('starts subagent at depth = currentDepth + 1', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner, currentDepth: 1 });
    await execute({ description: 'x' });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.depth).toBe(2);
  });

  it('forwards `reason` from the runner summary into the tool result when present', async () => {
    const runner: SubagentRunner = async () => ({
      status: 'max_budget',
      text: 'capped',
      costUsd: 1,
      durationMs: 5,
      reason: 'budget exceeded',
    });
    const { execute } = makeTool({ runSubagent: runner });
    const result = await execute({ description: 'x' });
    expect(result.status).toBe('max_budget');
    expect(result.reason).toBe('budget exceeded');
  });

  it('omits undefined optional summary fields from the returned tool result', async () => {
    const runner = makeRunnerOk({ status: 'success', text: 'hi' });
    // runner overrides costUsd/durationMs as undefined by not setting them
    const customRunner: SubagentRunner = async () => ({ status: 'success', text: 'hi' });
    const { execute } = makeTool({ runSubagent: customRunner });
    const result = await execute({ description: 'x' });
    expect(result.text).toBe('hi');
    expect(result.status).toBe('success');
    expect('costUsd' in result).toBe(false);
    expect('durationMs' in result).toBe(false);
    expect('reason' in result).toBe(false);
    // makeRunnerOk used elsewhere — keep linter happy
    expect(runner).toBeDefined();
  });
});

describe('spawn_subagent tool — lifecycle hooks', () => {
  it('fires SubagentStart before the runner and SubagentEnd after, with matching ids', async () => {
    const order: string[] = [];
    const runner: SubagentRunner = async () => {
      order.push('runner');
      return { status: 'success', text: 'ok' };
    };
    const events: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const emitter: SubagentLifecycleEmitter = async (event, payload) => {
      order.push(event);
      events.push({ event, payload });
    };
    const { execute } = makeTool({
      runSubagent: runner,
      onSubagentLifecycle: emitter,
    });

    await execute({ description: 'sub task', tools: ['read_file'] });

    expect(order).toEqual(['SubagentStart', 'runner', 'SubagentEnd']);
    expect(events).toHaveLength(2);

    const start = events[0].payload;
    if (start.event !== 'SubagentStart') throw new Error('expected SubagentStart');
    expect(start.parentSessionId).toBe('parent-session');
    expect(start.subagentSessionId).toMatch(/^parent-session:sub:/);
    expect(start.depth).toBe(1);
    expect(start.prompt).toBe('sub task');
    expect(start.toolNames).toEqual(['read_file']);

    const end = events[1].payload;
    if (end.event !== 'SubagentEnd') throw new Error('expected SubagentEnd');
    expect(end.parentSessionId).toBe('parent-session');
    expect(end.subagentSessionId).toBe(start.subagentSessionId);
    expect(end.depth).toBe(1);
    expect(end.result.status).toBe('success');
    expect(end.result.text).toBe('ok');
  });

  it('omits `toolNames` from SubagentStart payload when whitelist is not provided', async () => {
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({
      runSubagent: makeRunnerOk(),
      onSubagentLifecycle: emitter,
    });
    await execute({ description: 'x' });
    const start = events[0].payload;
    if (start.event !== 'SubagentStart') throw new Error('expected SubagentStart');
    expect('toolNames' in start).toBe(false);
  });

  it('is a no-op when onSubagentLifecycle is omitted (runner still runs)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    const result = await execute({ description: 'x' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
  });
});

describe('spawn_subagent tool — depth cap', () => {
  it('rejects when childDepth >= maxDepth (default 3 → reject from depth 2)', async () => {
    const runner = vi.fn<SubagentRunner>(async () => ({ status: 'success', text: 'x' }));
    const { execute } = makeTool({ runSubagent: runner, currentDepth: 2 });
    const result = await execute({ description: 'rejected' });
    expect(runner).not.toHaveBeenCalled();
    expect(result.error).toMatch(/max subagent depth \(3\) exceeded/);
    expect(result.subagentSessionId).toMatch(/^parent-session:sub:/);
    expect(result.status).toBeUndefined();
  });

  it('still fires SubagentStart + SubagentEnd on depth-cap rejection (matched pair)', async () => {
    const runner = vi.fn<SubagentRunner>(async () => ({ status: 'success', text: 'x' }));
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({
      runSubagent: runner,
      currentDepth: 2,
      onSubagentLifecycle: emitter,
    });
    await execute({ description: 'rejected' });
    expect(runner).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('SubagentStart');
    expect(events[1].event).toBe('SubagentEnd');
    const end = events[1].payload;
    if (end.event !== 'SubagentEnd') throw new Error('expected SubagentEnd');
    expect(end.result.status).toBe('error');
    expect(end.result.reason).toMatch(/max subagent depth \(3\) exceeded/);
    expect(end.result.text).toBe('');
  });

  it('respects custom maxDepth (cap=1 rejects at depth 0)', async () => {
    const runner = vi.fn<SubagentRunner>(async () => ({ status: 'success', text: 'x' }));
    const { execute } = makeTool({ runSubagent: runner, currentDepth: 0, maxDepth: 1 });
    const result = await execute({ description: 'x' });
    expect(runner).not.toHaveBeenCalled();
    expect(result.error).toMatch(/max subagent depth \(1\) exceeded/);
  });

  it('SubagentStart on the rejection path includes toolNames when supplied', async () => {
    const runner = vi.fn<SubagentRunner>(async () => ({ status: 'success', text: 'x' }));
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({
      runSubagent: runner,
      currentDepth: 2,
      onSubagentLifecycle: emitter,
    });
    await execute({ description: 'x', tools: ['read_file', 'grep_files'] });
    const start = events[0].payload;
    if (start.event !== 'SubagentStart') throw new Error('expected SubagentStart');
    expect(start.toolNames).toEqual(['read_file', 'grep_files']);
  });

  it('allows depth-1 spawn when default cap is in effect (currentDepth=0 → child=1 < 3)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner, currentDepth: 0 });
    const result = await execute({ description: 'allowed' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
  });
});

describe('spawn_subagent tool — abort composition', () => {
  it('composes parent signal from execCtx.signal into the subagent run config', async () => {
    const runner = vi.fn<SubagentRunner>(async (config) => {
      expect(config.signal).toBeInstanceOf(AbortSignal);
      return { status: 'success', text: 'ok' };
    });
    const parentCtl = new AbortController();
    const { execute } = makeTool({ runSubagent: runner });

    let capturedSignal: AbortSignal | null = null;
    const wrappedRunner: SubagentRunner = async (config) => {
      capturedSignal = config.signal;
      return runner(config);
    };
    const { execute: ex2 } = makeTool({ runSubagent: wrappedRunner });

    await ex2({ description: 'x' }, { signal: parentCtl.signal });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    parentCtl.abort();
    expect(capturedSignal!.aborted).toBe(true);

    // satisfy unused-var lint
    expect(execute).toBeDefined();
  });

  it('falls back to factory-time ctx.signal when execCtx has none', async () => {
    const factoryCtl = new AbortController();
    let capturedSignal: AbortSignal | null = null;
    const runner: SubagentRunner = async (config) => {
      capturedSignal = config.signal;
      return { status: 'success', text: 'ok' };
    };
    const t = spawnSubagentTool(
      { parentSessionId: 'p', runSubagent: runner },
      { cwd: '.', signal: factoryCtl.signal },
    );
    await (t.function.execute as ExecuteFn)({ description: 'x' });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
    factoryCtl.abort();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('uses just the subagent-internal controller when no parent signal is wired', async () => {
    let capturedSignal: AbortSignal | null = null;
    const runner: SubagentRunner = async (config) => {
      capturedSignal = config.signal;
      return { status: 'success', text: 'ok' };
    };
    const { execute } = makeTool({ runSubagent: runner }, { cwd: '.' });
    await execute({ description: 'x' });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
  });
});

describe('spawn_subagent tool — runner-throw path', () => {
  it('returns { error } and fires SubagentEnd with status=error + reason', async () => {
    const runner: SubagentRunner = async () => {
      throw new Error('boom');
    };
    const { emitter, events } = captureLifecycle();
    const { execute } = makeTool({ runSubagent: runner, onSubagentLifecycle: emitter });
    const result = await execute({ description: 'x' });

    expect(result.error).toBe('boom');
    expect(result.subagentSessionId).toMatch(/^parent-session:sub:/);
    expect(result.status).toBeUndefined();

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('SubagentStart');
    const end = events[1].payload;
    if (end.event !== 'SubagentEnd') throw new Error('expected SubagentEnd');
    expect(end.result.status).toBe('error');
    expect(end.result.reason).toBe('boom');
    expect(end.result.text).toBe('');
  });

  it('stringifies non-Error throws', async () => {
    const runner: SubagentRunner = async () => {
      throw 'string-throw';
    };
    const { execute } = makeTool({ runSubagent: runner });
    const result = await execute({ description: 'x' });
    expect(result.error).toBe('string-throw');
  });
});

describe('spawn_subagent tool — schema validation surface', () => {
  it('runs the execute path with all optional fields omitted (description-only)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    const result = await execute({ description: 'minimal' });
    expect(result.status).toBe('success');
  });
});

describe('spawn_subagent tool — Phase 4.8 per-subagent overrides', () => {
  it('forwards `model` override (snake_case input → camelCase config) to the runner', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({ description: 'x', model: 'openai/gpt-5-codex' });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.model).toBe('openai/gpt-5-codex');
  });

  it('forwards `permission_mode` override (snake_case → camelCase `permissionMode`) to the runner', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({ description: 'x', permission_mode: 'plan' });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.permissionMode).toBe('plan');
  });

  it('forwards `allowed_tools` override as `allowedTools` (rule grammar passes through verbatim)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({
      description: 'x',
      allowed_tools: ['read_file', 'Bash(echo *)'],
    });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.allowedTools).toEqual(['read_file', 'Bash(echo *)']);
  });

  it('forwards `disallowed_tools` override as `disallowedTools` (rule grammar passes through verbatim)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({
      description: 'x',
      disallowed_tools: ['Bash(rm *)'],
    });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.disallowedTools).toEqual(['Bash(rm *)']);
  });

  it('composes 4.7 `tools` narrowing with 4.8 `allowed_tools` (both layers reach the runner)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({
      description: 'x',
      tools: ['bash'],
      allowed_tools: ['bash(echo *)'],
    });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    // toolNames narrows the pool to bash only; allowedTools layers
    // the scoped echo-only rule on top — both arrive intact at the runner so
    // the agent-side wiring can compose them at child-construction time.
    expect(config.toolNames).toEqual(['bash']);
    expect(config.allowedTools).toEqual(['bash(echo *)']);
  });

  it('forwards `effort` pass-through to the runner config (Phase 5.4 wires this into the child callModel)', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({ description: 'x', effort: 'high' });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.effort).toBe('high');
  });

  it('omits override fields from the runner config when the spawn call omits them', async () => {
    const runner = makeRunnerOk();
    const { execute } = makeTool({ runSubagent: runner });
    await execute({ description: 'x' });
    const config = (runner as unknown as { mock: { calls: SubagentRunConfig[][] } }).mock
      .calls[0][0];
    expect(config.model).toBeUndefined();
    expect(config.permissionMode).toBeUndefined();
    expect(config.allowedTools).toBeUndefined();
    expect(config.disallowedTools).toBeUndefined();
    expect(config.effort).toBeUndefined();
  });

  it('overrides do not mutate the factory options object (parent state is preserved)', async () => {
    // Snapshot the SpawnSubagentToolOptions before spawn → verify each spawn
    // call leaves the factory-time opts untouched. This guards the invariant
    // "overrides apply to the child run's ctor args only" — the parent's
    // SpawnSubagentToolOptions instance must not pick up the override values.
    const runner = makeRunnerOk();
    const factoryOpts: SpawnSubagentToolOptions = {
      parentSessionId: 'parent-session',
      runSubagent: runner,
    };
    const snapshot = JSON.parse(
      JSON.stringify({ ...factoryOpts, runSubagent: undefined }),
    ) as Record<string, unknown>;
    const t = spawnSubagentTool(factoryOpts, { cwd: '.' });
    const execute = t.function.execute as ExecuteFn;
    await execute({
      description: 'x',
      permission_mode: 'plan',
      allowed_tools: ['read_file'],
      disallowed_tools: ['Bash(rm *)'],
      model: 'openai/gpt-5',
      effort: 'high',
    });
    expect(JSON.parse(JSON.stringify({ ...factoryOpts, runSubagent: undefined }))).toEqual(
      snapshot,
    );
  });

  it('zod schema rejects an invalid `permission_mode` value at parse time', async () => {
    const { tool } = makeTool({ runSubagent: makeRunnerOk() });
    // The factory exposes the Zod schema as `function.inputSchema` per the
    // OR SDK's tool-types contract; parse the raw input directly to assert
    // the schema-level rejection.
    const schema = (tool.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    expect(() =>
      schema.parse({ description: 'x', permission_mode: 'definitely-not-a-mode' }),
    ).toThrow();
  });

  it('Phase 5.4: zod schema rejects an unknown `effort` value at parse time', async () => {
    const { tool } = makeTool({ runSubagent: makeRunnerOk() });
    const schema = (tool.function as unknown as { inputSchema: { parse: (i: unknown) => unknown } })
      .inputSchema;
    expect(() => schema.parse({ description: 'x', effort: 'ultra' })).toThrow();
    // Every documented enum value parses cleanly.
    for (const v of ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const) {
      expect(() => schema.parse({ description: 'x', effort: v })).not.toThrow();
    }
  });
});
