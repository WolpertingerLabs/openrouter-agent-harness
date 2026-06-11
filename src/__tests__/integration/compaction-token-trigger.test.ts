import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun, MODEL_CONTEXT_LENGTH_CACHE } from '../../index.js';
import type { AgentCoreEvent, HookEvent, HookPayload, UserInput } from '../../index.js';

const SESSION = 'integration-compaction-token';

/**
 * Build a cycle fixture whose final response reports `inputTokens`. The
 * Phase 7.1 mid-run trigger reads this to decide whether to compact at the
 * top of the next cycle.
 */
function cycleFixture(name: string, inputTokens: number): Fixture {
  return {
    name,
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'ok' } },
      { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
    ],
    response: {
      id: `resp-${name}`,
      model: 'mock-model',
      usage: { cost: 0.001, inputTokens, outputTokens: 5, totalTokens: inputTokens + 5 },
      output: [],
    },
  };
}

function compactFixture(summary: string): Fixture {
  return {
    name: 'compact',
    steps: [{ type: 'yield', event: { type: 'response.output_text.delta', delta: summary } }],
    response: {
      id: 'resp-compact',
      model: 'mock-model',
      usage: { cost: 0.0001, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      output: [],
    },
  };
}

async function seedState(opts: {
  logsRoot: string;
  sessionId: string;
  messages: unknown[];
}): Promise<string> {
  const dir = join(opts.logsRoot, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      id: opts.sessionId,
      messages: opts.messages,
      status: 'complete',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return path;
}

/** Build an AsyncIterable prompt yielding N user inputs (drives N callModel cycles). */
async function* multiInput(...contents: string[]): AsyncIterable<UserInput> {
  for (const content of contents) yield { content };
}

const longMessages = (): unknown[] => [
  { role: 'user', content: 'a'.repeat(100) },
  { role: 'assistant', content: 'b'.repeat(100) },
  { role: 'user', content: 'c'.repeat(100) },
  { role: 'assistant', content: 'd'.repeat(100) },
  { role: 'user', content: 'e'.repeat(100) },
  { role: 'assistant', content: 'f'.repeat(100) },
];

let logsRoot: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  state.fixture = null;
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-token-'));
  MODEL_CONTEXT_LENGTH_CACHE.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
  MODEL_CONTEXT_LENGTH_CACHE.clear();
});

describe('integration: Phase 7.1 real-token mid-run compaction', () => {
  it('compacts mid-run (top of next cycle) when real inputTokens crosses the token threshold', async () => {
    // A tiny explicit window so the default reserve(20k)+buffer(8k) floors the
    // threshold at 25% of the window = 5000 tokens. Cycle 1 reports 9000 input
    // tokens — over the threshold — so the trigger marks compaction, which the
    // top of cycle 2 performs BEFORE the second callModel runs.
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages(),
    });

    state.fixtureQueue = [
      cycleFixture('cycle1-over', 9000),
      compactFixture('MID-RUN-SUMMARY'),
      cycleFixture('cycle2-after', 100),
    ];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: multiInput('first', 'second'),
      logsRoot,
      contextWindowTokens: 20_000, // floor → 5000-token threshold
      keepRecentTurns: 2,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');

    // Three callModel invocations in order: cycle1 → compaction → cycle2.
    expect(state.callModelArgs.length).toBe(3);
    const compactArgs = state.callModelArgs[1] as { sessionId: string };
    expect(compactArgs.sessionId).toMatch(/^integration-compaction-token:compact:/);

    // PreCompact fired exactly once, mid-run (auto).
    const compactHooks = hookEvents.filter((h) => h.event === 'PreCompact');
    expect(compactHooks.length).toBe(1);
    expect((compactHooks[0].payload as Extract<HookPayload, { event: 'PreCompact' }>).reason).toBe(
      'auto',
    );

    // State was rewritten with the summary + last 2 TURNS. Phase 7.2 turn
    // granularity: keepRecentTurns:2 over the [u,a]×3 seed keeps the final
    // two turns ([c,d,e,f] = 4 messages), so the rebuilt history is
    // [summary, ...4] = 5 messages and the kept tail starts at a user-role
    // turn boundary (never an orphaned function_call_output / reasoning item).
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].role).toBe('developer');
    expect(persisted.messages[0].content).toContain('MID-RUN-SUMMARY');
    expect(persisted.messages.length).toBe(5);
    expect(persisted.messages[1].role).toBe('user');
  });

  it('does NOT compact mid-run when real inputTokens stays below the threshold', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });

    state.fixtureQueue = [cycleFixture('c1', 100), cycleFixture('c2', 100)];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: multiInput('first', 'second'),
      logsRoot,
      contextWindowTokens: 200_000, // threshold ≈ 172k — far above 100 tokens
      keepRecentTurns: 2,
      onHook: (event) => hookEvents.push(event),
    });

    for await (const _ of run) void _;

    // Only the two cycle calls — no compaction sub-call.
    expect(state.callModelArgs.length).toBe(2);
    expect(hookEvents).not.toContain('PreCompact');
  });

  it('resolves an unknown model context window from the (mocked) /models endpoint', async () => {
    // The model is absent from the static MODEL_CONTEXT_WINDOWS table; the
    // live lookup supplies a 16k window → threshold floored to 4000 tokens.
    // Cycle 1 reports 9000 tokens, over the threshold → compaction fires.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'novel/model-7000', context_length: 16_000 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages(),
    });

    state.fixtureQueue = [
      cycleFixture('c1', 9000),
      compactFixture('LIVE-WINDOW-SUMMARY'),
      cycleFixture('c2', 100),
    ];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      model: 'novel/model-7000',
      prompt: multiInput('first', 'second'),
      logsRoot,
      keepRecentTurns: 2,
      onHook: (event) => hookEvents.push(event),
    });

    for await (const _ of run) void _;

    // The /models endpoint was queried for the window.
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/\/models$/);

    expect(hookEvents).toContain('PreCompact');
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('LIVE-WINDOW-SUMMARY');
  });

  it('falls back to the static table when the /models lookup fails (no hard network dep)', async () => {
    // The lookup throws — compaction must still resolve the window from the
    // static table (anthropic/claude-sonnet-4.6 = 200k) and therefore NOT
    // compact at 9000 input tokens (threshold ≈ 172k).
    fetchMock.mockRejectedValue(new Error('network down'));
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });

    state.fixtureQueue = [cycleFixture('c1', 9000), cycleFixture('c2', 9000)];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      model: 'anthropic/claude-sonnet-4.6',
      prompt: multiInput('first', 'second'),
      logsRoot,
      keepRecentTurns: 2,
      onHook: (event) => hookEvents.push(event),
    });

    for await (const _ of run) void _;

    // Lookup attempted but failed → static-table window → no compaction.
    expect(fetchMock).toHaveBeenCalled();
    expect(state.callModelArgs.length).toBe(2);
    expect(hookEvents).not.toContain('PreCompact');
  });

  it('explicit char-denominated compactionThreshold wins outright over the token path', async () => {
    // With an explicit char threshold, the token machinery (and the /models
    // lookup) is bypassed entirely: the comparison is char-based exactly as
    // v1. Seeded messages (~600 chars) exceed the 100-char threshold, so
    // compaction fires regardless of the (tiny) reported inputTokens.
    fetchMock.mockRejectedValue(new Error('should not be called'));
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages(),
    });

    state.fixtureQueue = [
      cycleFixture('c1', 1), // 1 token — far below any token threshold
      compactFixture('CHAR-THRESHOLD-SUMMARY'),
      cycleFixture('c2', 1),
    ];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: multiInput('first', 'second'),
      logsRoot,
      compactionThreshold: 100, // chars — wins outright
      keepRecentTurns: 2,
      onHook: (event) => hookEvents.push(event),
    });

    for await (const _ of run) void _;

    expect(hookEvents).toContain('PreCompact');
    // The /models endpoint was never consulted — explicit char threshold path.
    expect(fetchMock).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('CHAR-THRESHOLD-SUMMARY');
  });

  it('run-end compaction fires (and swallows failures) on a max_turns exit', async () => {
    // maxTurns=1 forces a max_turns completion that `break`s out of the loop
    // BEFORE the loop-top consumes the pending flag — so the run-end block in
    // `finally` performs the compaction. A throwing compaction fixture proves
    // the run-end failure path swallows + logs without breaking the stream.
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });

    state.fixtureQueue = [
      cycleFixture('c1', 9000),
      { name: 'compact-throws', steps: [{ type: 'throw', message: 'boom' }] },
    ];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'single',
      logsRoot,
      maxTurns: 1, // → max_turns exit, run-end compaction path
      contextWindowTokens: 20_000,
      keepRecentTurns: 2,
      logger: (level, message) => logEntries.push({ level, message }),
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_turns');
    // The run-end (not mid-run) failure message was logged.
    expect(logEntries.find((l) => l.message === 'Auto-compaction failed')?.level).toBe('error');
  });

  it('skips the run-end summarizer call when persistSession is false', async () => {
    // A non-persistent session has no on-disk state to condense for a future
    // run; the run-end summarizer call is pure waste and is skipped. There is
    // also no state.json for compact() to read, so no sub-call can occur.
    state.fixtureQueue = [cycleFixture('c1', 9000)];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'single',
      logsRoot,
      persistSession: false,
      contextWindowTokens: 20_000,
      keepRecentTurns: 2,
    });

    for await (const _ of run) void _;

    // Only the one cycle call — no compaction sub-call.
    expect(state.callModelArgs.length).toBe(1);
  });
});
