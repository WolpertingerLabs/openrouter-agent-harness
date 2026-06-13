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
import { loadPlugins } from './plugins/index.js';
import type { HookEvent, HookPayload } from './events.js';
import type { Tool } from '@openrouter/agent';

let ROOT: string;
let HOME_DIR: string;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'agent-plugins-int-'));
  HOME_DIR = join(ROOT, 'home');
  await mkdir(HOME_DIR, { recursive: true });
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  // Default mock so any drained run completes.
  callModelMock.mockImplementation(() => ({
    async *getFullResponsesStream() {
      /* empty */
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
  }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

async function writePluginManifest(root: string, manifest: object): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

async function writeSkill(
  baseDir: string,
  name: string,
  yaml: string,
  body: string,
): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${yaml}\n---\n${body}`, 'utf8');
}

function captureCallArgs() {
  let captured: { tools?: Tool[]; instructions?: string } | undefined;
  callModelMock.mockImplementation((request: { tools?: Tool[]; instructions?: string }) => {
    captured = { tools: request.tools, instructions: request.instructions };
    return {
      async *getFullResponsesStream() {
        /* empty */
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

describe('OpenRouterAgentRun — plugin wiring', () => {
  it('fires PluginStart with correct contribution counts for each plugin', async () => {
    const a = join(ROOT, 'plugin-a');
    const b = join(ROOT, 'plugin-b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writePluginManifest(a, { name: 'plugin-a' });
    await writePluginManifest(b, { name: 'plugin-b' });
    await writeSkill(join(a, 'skills'), 'foo', 'name: foo\ndescription: A foo', 'body');
    await writeSkill(join(b, 'skills'), 'bar', 'name: bar\ndescription: A bar', 'body');

    const plugins = await loadPlugins({ pluginDirs: [a, b], home: HOME_DIR });

    const calls: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-start',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      onHook: (event, payload) => {
        calls.push({ event, payload });
      },
    });
    for await (const _ of run) {
      void _;
    }
    const starts = calls.filter((c) => c.event === 'PluginStart');
    expect(starts).toHaveLength(2);
    const names = starts.map((s) => (s.payload as { pluginName: string }).pluginName).sort();
    expect(names).toEqual(['plugin-a', 'plugin-b']);
    for (const s of starts) {
      const p = s.payload as Extract<HookPayload, { event: 'PluginStart' }>;
      expect(p.contributions.skills).toBeGreaterThanOrEqual(1);
    }
  });

  it('fires PluginStop on run finalization paired 1:1 with PluginStart', async () => {
    const a = join(ROOT, 'plugin-a');
    await mkdir(a, { recursive: true });
    await writePluginManifest(a, { name: 'plugin-a' });

    const plugins = await loadPlugins({ pluginDirs: [a], home: HOME_DIR });
    const events: Array<{ event: HookEvent; payload: HookPayload }> = [];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-stop',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      onHook: (event, payload) => {
        events.push({ event, payload });
      },
    });
    for await (const _ of run) {
      void _;
    }
    const stops = events.filter((c) => c.event === 'PluginStop');
    expect(stops).toHaveLength(1);
    const p = stops[0]?.payload as Extract<HookPayload, { event: 'PluginStop' }>;
    expect(p.pluginName).toBe('plugin-a');
    expect(p.reason).toBe('closed');
    expect(typeof p.durationMs).toBe('number');

    const startIdx = events.findIndex((c) => c.event === 'PluginStart');
    const stopIdx = events.findIndex((c) => c.event === 'PluginStop');
    expect(startIdx).toBeLessThan(stopIdx);
  });

  it('namespaces plugin skills as <pluginName>:<skillName> (no collision)', async () => {
    const a = join(ROOT, 'pa');
    const b = join(ROOT, 'pb');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writePluginManifest(a, { name: 'pa' });
    await writePluginManifest(b, { name: 'pb' });
    await writeSkill(join(a, 'skills'), 'analyze', 'name: analyze\ndescription: A', 'A');
    await writeSkill(join(b, 'skills'), 'analyze', 'name: analyze\ndescription: B', 'B');

    const plugins = await loadPlugins({ pluginDirs: [a, b], home: HOME_DIR });

    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-ns',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
    });
    for await (const _ of run) {
      void _;
    }
    const captured = peek();
    expect(captured?.instructions).toContain('pa:analyze');
    expect(captured?.instructions).toContain('pb:analyze');
  });

  it('renders ${CLAUDE_PLUGIN_ROOT} in a plugin-shipped skill body via the skill loader', async () => {
    const a = join(ROOT, 'has-root');
    await mkdir(a, { recursive: true });
    await writePluginManifest(a, { name: 'has-root' });
    await writeSkill(
      join(a, 'skills'),
      'show',
      'name: show\ndescription: Shows root',
      'plugin lives at ${CLAUDE_PLUGIN_ROOT}',
    );

    const plugins = await loadPlugins({ pluginDirs: [a], home: HOME_DIR });
    // Build a SkillLoader the same way the agent does, then call render directly
    // — this exercises the same code path the Skill tool uses at invocation
    // time without requiring an end-to-end mock of the model loop.
    const { createSkillLoader } = await import('./skills/index.js');
    const loader = createSkillLoader({
      cwd: ROOT,
      home: HOME_DIR,
      pluginRoots: plugins.map((p) => ({
        name: p.manifest.name,
        root: p.root,
        skillsDir: p.skillRoots[0]!,
      })),
    });
    const skills = await loader.list();
    const target = skills.find((s) => s.name === 'has-root:show');
    expect(target).toBeDefined();
    const rendered = await loader.render('has-root:show', {
      arguments: [],
      sessionId: 's',
      projectDir: ROOT,
      pluginRoot: plugins[0]!.root,
      pluginData: plugins[0]!.dataDir,
    });
    expect(rendered).toContain(`plugin lives at ${plugins[0]!.root}`);
  });

  it('integration — agent run sees skill + command + hook contributions from a single plugin', async () => {
    const root = join(ROOT, 'fixture');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'fixture',
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] },
    });
    await writeSkill(join(root, 'skills'), 'demo', 'name: demo\ndescription: A demo skill', 'body');
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(
      join(root, 'commands', 'go.md'),
      '---\ndescription: do thing\n---\ngo body',
      'utf8',
    );

    const plugins = await loadPlugins({ pluginDirs: [root], home: HOME_DIR });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.commandRoots).toEqual([join(root, 'commands')]);

    const starts: Array<Extract<HookPayload, { event: 'PluginStart' }>> = [];
    const peek = captureCallArgs();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-fixture',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      onHook: (event, payload) => {
        if (event === 'PluginStart') {
          starts.push(payload as Extract<HookPayload, { event: 'PluginStart' }>);
        }
      },
    });
    for await (const _ of run) {
      void _;
    }
    const captured = peek();
    expect(captured?.instructions).toContain('fixture:demo');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.contributions).toMatchObject({
      skills: expect.any(Number),
      commands: expect.any(Number),
      mcpServers: 0,
      hooks: 1,
    });
  });

  it('warns when plugins are supplied alongside a pre-built skills loader', async () => {
    const a = join(ROOT, 'p1');
    await mkdir(a, { recursive: true });
    await writePluginManifest(a, { name: 'p1' });

    const plugins = await loadPlugins({ pluginDirs: [a], home: HOME_DIR });
    const { createSkillLoader } = await import('./skills/index.js');
    const preBuilt = createSkillLoader({ cwd: ROOT, home: HOME_DIR });

    const warnings: string[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-warn',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      skills: preBuilt,
      logger: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    for await (const _ of run) {
      void _;
    }
    expect(warnings.some((m) => m.includes('plugins supplied alongside'))).toBe(true);
  });

  it('appends plugin mcpServers to the base list resolved by the agent (namespaced)', async () => {
    const root = join(ROOT, 'has-mcp');
    await mkdir(root, { recursive: true });
    await writePluginManifest(root, {
      name: 'has-mcp',
      mcpServers: { sock: { url: 'http://127.0.0.1:1/never' } },
    });
    const plugins = await loadPlugins({ pluginDirs: [root], home: HOME_DIR });
    expect(plugins[0]?.mcpServers).toHaveLength(1);
    expect(plugins[0]?.mcpServers[0]?.name).toBe('has-mcp:sock');
    // We assert the loader output rather than spinning up the bridge — the
    // bridge tests already cover server lifecycle and the plugin contribution
    // is composed by `resolveMcpServers` which is exercised below in
    // `OpenRouterAgentRun` indirectly via the PluginStart count.
    const counts: Array<number> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-mcp',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      // Override to empty so the bridge skips spawn entirely — but the
      // PluginStart contribution count is taken from `plugin.mcpServers`,
      // not from the bridge's spawn outcome.
      mcpServers: [],
      onHook: (event, payload) => {
        if (event === 'PluginStart') {
          counts.push(
            (payload as Extract<HookPayload, { event: 'PluginStart' }>).contributions.mcpServers,
          );
        }
      },
    });
    for await (const _ of run) {
      void _;
    }
    expect(counts).toEqual([1]);
  });

  it('does not fire PluginStart when the run aborts before MCP/plugin init', async () => {
    const a = join(ROOT, 'p1');
    await mkdir(a, { recursive: true });
    await writePluginManifest(a, { name: 'p1' });
    const plugins = await loadPlugins({ pluginDirs: [a], home: HOME_DIR });

    const ac = new AbortController();
    ac.abort();
    const events: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'p-int-aborted',
      prompt: 'hi',
      cwd: ROOT,
      persistSession: false,
      plugins,
      signal: ac.signal,
      onHook: (event) => {
        events.push(event);
      },
    });
    for await (const _ of run) {
      void _;
    }
    expect(events).not.toContain('PluginStart');
    // PluginStop must NOT fire when its matching PluginStart never fired.
    expect(events).not.toContain('PluginStop');
  });
});
