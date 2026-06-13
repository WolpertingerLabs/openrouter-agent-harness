import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
  const isToolCallOutputEvent = (e: unknown) =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
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
import { createSkillLoader } from './skills/index.js';
import type { SkillLoader } from './skills/index.js';
import type { Tool } from '@openrouter/agent';

let ROOT: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'agent-skills-int-'));
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writeSkill(name: string, yaml: string, body: string): Promise<void> {
  await mkdir(join(ROOT, '.git'), { recursive: true });
  const dir = join(ROOT, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${body}`, 'utf8');
}

function captureCallArgs(events: unknown[] = []) {
  let captured: { tools?: Tool[]; instructions?: string } | undefined;
  callModelMock.mockImplementation((request: { tools?: Tool[]; instructions?: string }) => {
    captured = { tools: request.tools, instructions: request.instructions };
    return {
      async *getFullResponsesStream() {
        for (const e of events) yield e;
      },
      async getResponse() {
        return {
          id: 'r1',
          model: 'mock',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [],
        };
      },
      async cancel() {
        /* noop */
      },
    };
  });
  return () => captured;
}

describe('OpenRouterAgentRun — skills wiring', () => {
  it('injects the `## Available Skills` block into instructions', async () => {
    await writeSkill('greet', 'name: greet\ndescription: say hello', 'BODY');
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-1',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    // Drain events.
    for await (const _ of run) {
      void _;
    }
    const captured = peek();
    expect(captured?.instructions).toContain('## Available Skills');
    expect(captured?.instructions).toContain('greet');
    expect(captured?.tools?.find((t) => t.function.name === 'skill')).toBeDefined();
  });

  it('omits the listing when no skills are discovered', async () => {
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-2',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    for await (const _ of run) void _;
    const captured = peek();
    expect(captured?.instructions ?? '').not.toContain('## Available Skills');
    // skill tool is also not added when no skills are present? Actually we
    // still register it for the rare case the model knows a name by other
    // means. Allow either — we only assert the listing is gone.
  });

  it('skillsDir convenience option constructs a default loader', async () => {
    await writeSkill('alpha', 'name: alpha\ndescription: A', 'BODY');
    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-3',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skillsDir: ROOT,
    });
    for await (const _ of run) void _;
    const captured = peek();
    expect(captured?.instructions).toContain('alpha');
  });

  it('binds named-arguments frontmatter through to substitution', async () => {
    await writeSkill(
      'named-args',
      'name: named-args\narguments: [file, branch]',
      'open $file on $branch',
    );
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });

    callModelMock.mockImplementation((request: { tools?: Tool[] }) => {
      const skill = request.tools?.find((t) => t.function.name === 'skill') as
        | { function: { execute: (input: unknown, ctx?: unknown) => Promise<unknown> } }
        | undefined;
      return {
        async *getFullResponsesStream() {
          yield { type: 'turn.start', turnNumber: 0 };
          if (skill) {
            const out = await skill.function.execute({
              name: 'named-args',
              arguments: 'src/x.ts main',
            });
            yield {
              type: 'tool.call_output',
              output: { callId: 'c1', output: out, status: 'completed' },
            };
          }
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return {
            id: 'r',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
        async cancel() {
          /* noop */
        },
      };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-named',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    const outs: unknown[] = [];
    for await (const ev of run) {
      if (ev.type === 'tool_result') outs.push(ev.output);
    }
    const result = outs[0] as { content: string };
    expect(result.content).toBe('open src/x.ts on main');
  });

  it('drops the skill listing when every discovered skill is disable-model-invocation', async () => {
    await writeSkill('hidden', 'name: hidden\ndisable-model-invocation: true', 'BODY');
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-hidden',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    for await (const _ of run) void _;
    const captured = peek();
    expect(captured?.instructions ?? '').not.toContain('## Available Skills');
  });

  it('the skill tool renders a body and surfaces it as the tool result', async () => {
    await writeSkill('inline', 'name: inline', 'rendered: $1');
    const loader = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });

    // Drive the agent through one tool call to skill({name:'inline', arguments:'world'})
    // by emitting a function_call event followed by the matching tool_call_output
    // that the SDK would normally produce. We then read the surfaced tool_result
    // payload off the event stream.
    callModelMock.mockImplementation((request: { tools?: Tool[] }) => {
      const skill = request.tools?.find((t) => t.function.name === 'skill') as
        | { function: { execute: (input: unknown, ctx?: unknown) => Promise<unknown> } }
        | undefined;
      return {
        async *getFullResponsesStream() {
          yield { type: 'turn.start', turnNumber: 0 };
          yield {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              callId: 'c1',
              name: 'skill',
              arguments: JSON.stringify({ name: 'inline', arguments: 'world' }),
            },
          };
          // Synthesise a tool_call_output by calling the tool ourselves.
          if (skill) {
            const out = await skill.function.execute({ name: 'inline', arguments: 'world' });
            yield {
              type: 'tool.call_output',
              output: { callId: 'c1', output: out, status: 'completed' },
            };
          }
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return {
            id: 'r',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
        async cancel() {
          /* noop */
        },
      };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-int-4',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    const results: Array<{ type: string; output?: unknown }> = [];
    for await (const ev of run) {
      if (ev.type === 'tool_result') results.push({ type: ev.type, output: ev.output });
    }
    expect(results).toHaveLength(1);
    const out = results[0]!.output as { content: string; name: string };
    expect(out.name).toBe('inline');
    expect(out.content).toBe('rendered: world');
  });
});

describe('OpenRouterAgentRun — skills `allowed-tools` narrowing (inline render)', () => {
  // Builds a SkillLoader that delegates list/get to the real one but suspends
  // render() on a manually-controlled promise so we can probe other wrapped
  // tools' canUseTool gate while `activeSkill` is set.
  function deferredLoader(real: SkillLoader): {
    loader: SkillLoader;
    release: (text: string) => void;
    waitUntilActive: () => Promise<void>;
  } {
    let release!: (text: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });
    let resolveActive!: () => void;
    const active = new Promise<void>((r) => {
      resolveActive = r;
    });
    const loader: SkillLoader = {
      list: () => real.list(),
      get: (name) => real.get(name),
      render: () => {
        // render() is only awaited AFTER onSkillActive has installed the
        // active context — signal here so the test can probe the gate.
        resolveActive();
        return pending;
      },
      watch: (cb) => real.watch(cb),
    };
    return { loader, release, waitUntilActive: () => active };
  }

  function findTool(tools: readonly Tool[] | undefined, name: string): Tool {
    const t = tools?.find((x) => x.function.name === name);
    if (!t) throw new Error(`tool '${name}' not in captured tools`);
    return t;
  }

  it('denies a non-listed tool mid-render with skill+tool in the reason', async () => {
    await writeSkill('narrow', 'name: narrow\nallowed-tools: read_file', 'BODY');
    const real = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const { loader, release, waitUntilActive } = deferredLoader(real);

    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-narrow-deny',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    for await (const _ of run) void _;

    const tools = peek()?.tools;
    const skillT = findTool(tools, 'skill');
    const editT = findTool(tools, 'edit_file');
    const skillExec = (skillT.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const editExec = (editT.function as { execute: (i: unknown) => Promise<unknown> }).execute;

    // Kick off the skill render. waitUntilActive resolves the moment the
    // skill tool calls loader.render(), which is AFTER onSkillActive has
    // installed the active-skill context but BEFORE the render itself
    // settles (we control that via `release`).
    const renderPromise = skillExec({ name: 'narrow' });
    await waitUntilActive();

    let denied: Error | undefined;
    try {
      await editExec({ path: 'x.txt', edits: [{ old_text: 'a', new_text: 'b' }] });
    } catch (err) {
      denied = err as Error;
    }
    expect(denied).toBeDefined();
    const payload = JSON.parse(denied!.message) as { error: string; denied: boolean };
    expect(payload.denied).toBe(true);
    expect(payload.error).toContain('edit_file');
    expect(payload.error).toContain('narrow');

    release('BODY');
    await renderPromise;
  });

  it('allows a listed tool mid-render (narrow check passes through)', async () => {
    await writeSkill('narrow-pass', 'name: narrow-pass\nallowed-tools: read_file', 'BODY');
    const real = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const { loader, release, waitUntilActive } = deferredLoader(real);

    // Real file so the underlying read_file execute resolves cleanly.
    const probePath = join(ROOT, 'probe.txt');
    await writeFile(probePath, 'hello-narrow', 'utf8');

    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-narrow-allow',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
    });
    for await (const _ of run) void _;

    const tools = peek()?.tools;
    const skillT = findTool(tools, 'skill');
    const readT = findTool(tools, 'read_file');
    const skillExec = (skillT.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const readExec = (readT.function as { execute: (i: unknown) => Promise<unknown> }).execute;

    const renderPromise = skillExec({ name: 'narrow-pass' });
    await waitUntilActive();

    const out = (await readExec({ path: probePath })) as { content: string };
    expect(out.content).toContain('hello-narrow');

    release('BODY');
    await renderPromise;
  });

  it('run-level disallowedTools beats skill `allowed-tools` (run-level deny-wins)', async () => {
    await writeSkill('narrow-deny', 'name: narrow-deny\nallowed-tools: read_file', 'BODY');
    const real = createSkillLoader({ cwd: ROOT, home: join(ROOT, 'no-home') });
    const { loader, release, waitUntilActive } = deferredLoader(real);

    const probePath = join(ROOT, 'probe.txt');
    await writeFile(probePath, 'wont-be-read', 'utf8');

    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'sk-narrow-runlevel',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      skills: loader,
      // Run-level deny on the same tool the skill allows. Run-level wins.
      disallowedTools: ['Read'],
    });
    for await (const _ of run) void _;

    const tools = peek()?.tools;
    const skillT = findTool(tools, 'skill');
    const readT = findTool(tools, 'read_file');
    const skillExec = (skillT.function as { execute: (i: unknown) => Promise<unknown> }).execute;
    const readExec = (readT.function as { execute: (i: unknown) => Promise<unknown> }).execute;

    const renderPromise = skillExec({ name: 'narrow-deny' });
    await waitUntilActive();

    let denied: Error | undefined;
    try {
      await readExec({ path: probePath });
    } catch (err) {
      denied = err as Error;
    }
    expect(denied).toBeDefined();
    const payload = JSON.parse(denied!.message) as { error: string; denied: boolean };
    expect(payload.denied).toBe(true);
    expect(payload.error).toContain('disallowedTools');

    release('BODY');
    await renderPromise;
  });
});
