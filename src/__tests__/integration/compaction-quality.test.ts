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

import { OpenRouterAgentRun, COMPACTION_PROMPT, COMPACTION_SUMMARY_MARKER } from '../../index.js';
import type { AgentCoreEvent, HookEvent, HookPayload } from '../../index.js';

const SESSION = 'integration-compaction-quality';

function parentFixture(): Fixture {
  return {
    name: 'parent-trivial',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: 'done' } },
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

const seededMessages = (prefix = '') => [
  { role: 'user', content: `${prefix}please fix the flaky test ` + 'pad'.repeat(40) },
  { role: 'assistant', content: 'looking into it '.repeat(20) },
  { role: 'user', content: `${prefix}also update the docs ` + 'pad'.repeat(40) },
  { role: 'assistant', content: 'done with part one '.repeat(20) },
  { role: 'user', content: `${prefix}now run the suite ` + 'pad'.repeat(40) },
  { role: 'assistant', content: 'suite is green '.repeat(20) },
];

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

let logsRoot: string;

beforeEach(async () => {
  state.fixture = null;
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-quality-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('integration: Phase 7.5 summary quality & ergonomics', () => {
  it('emits a live `compaction` event in-stream, immediately before stream_complete', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });
    state.fixtureQueue = [parentFixture(), compactFixture('LIVE-EVENT-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    const types = events.map((e) => e.type);
    const compactionIdx = types.indexOf('compaction');
    const completeIdx = types.indexOf('stream_complete');
    expect(compactionIdx).toBeGreaterThan(-1);
    expect(compactionIdx).toBe(completeIdx - 1);

    const compaction = events[compactionIdx] as Extract<AgentCoreEvent, { type: 'compaction' }>;
    expect(compaction.reason).toBe('auto');
    expect(compaction.droppedMessages).toBe(4); // 6 seeded, keepRecentTurns(1) TURN = last 2 msgs kept
    expect(compaction.preEstimatedTokens).toBeGreaterThan(0);
    expect(compaction.postEstimatedTokens).toBeGreaterThan(0);
    expect(compaction.postEstimatedTokens).toBeLessThan(compaction.preEstimatedTokens);
  });

  it('fires the PostCompact hook after PreCompact with the matching result payload', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });
    state.fixtureQueue = [parentFixture(), compactFixture('HOOK-SUMMARY')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
      onHook: (event, payload) => hookEvents.push({ event, payload }),
    });
    for await (const _ of run) void _;

    const preIdx = hookEvents.findIndex((h) => h.event === 'PreCompact');
    const postIdx = hookEvents.findIndex((h) => h.event === 'PostCompact');
    expect(preIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(preIdx);
    const payload = hookEvents[postIdx]!.payload as Extract<HookPayload, { event: 'PostCompact' }>;
    expect(payload.reason).toBe('auto');
    expect(payload.droppedMessages).toBe(4);
    expect(payload.summaryText).toBe('HOOK-SUMMARY');
    expect(payload.postEstimatedTokens).toBeLessThan(payload.preEstimatedTokens);
  });

  it('summarizes on the cheaper compactionModel while the run keeps its own model', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });
    state.fixtureQueue = [parentFixture(), compactFixture('CHEAP-MODEL-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      model: 'anthropic/claude-sonnet-4.6',
      compactionModel: 'anthropic/claude-haiku-4.5',
      compactionThreshold: 100,
      keepRecentTurns: 1,
    });
    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(2);
    expect((state.callModelArgs[0] as { model: string }).model).toBe('anthropic/claude-sonnet-4.6');
    expect((state.callModelArgs[1] as { model: string }).model).toBe('anthropic/claude-haiku-4.5');
  });

  it('compact(reason, { instructions }) appends the focus to the structured prompt', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });
    state.fixtureQueue = [compactFixture('FOCUSED-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    const result = await run.compact('manual', {
      instructions: 'the database migration steps',
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('manual');
    expect(result!.summaryText).toBe('FOCUSED-SUMMARY');
    const args = state.callModelArgs[0] as { instructions: string };
    expect(args.instructions.startsWith(COMPACTION_PROMPT)).toBe(true);
    expect(args.instructions).toContain('the database migration steps');
  });

  it('repeat compactions never nest: kept user messages contain no prior summary', async () => {
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });

    // First compaction (manual, no iteration needed).
    state.fixtureQueue = [compactFixture('FIRST-SUMMARY')];
    const run1 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    expect(await run1.compact()).not.toBeNull();

    const afterFirst = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(afterFirst.messages[0].content).toContain('FIRST-SUMMARY');

    // Simulate the conversation continuing after the first compaction: a new
    // turn with a large (droppable) assistant message, then a final turn.
    // Without new content, re-compacting an already-condensed history is
    // correctly a no-op under the Phase 7.3 inflation check (the verbatim user
    // messages, Phase 7.5, are re-kept and nothing meaningful shrinks).
    afterFirst.messages.push(
      { role: 'user', content: 'and now refactor the shared helper' },
      { role: 'assistant', content: 'refactoring the helper '.repeat(200) },
      { role: 'user', content: 'ship it' },
      { role: 'assistant', content: 'shipped' },
    );
    await writeFile(statePath, JSON.stringify(afterFirst));

    // Second compaction over the rebuilt history (which now contains the
    // FIRST summary + verbatim user messages + keep tail + the new turns).
    state.fixtureQueue = [compactFixture('SECOND-SUMMARY')];
    const run2 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    expect(await run2.compact()).not.toBeNull();

    const afterSecond = JSON.parse(await readFile(statePath, 'utf-8'));
    const [head, ...rest] = afterSecond.messages as Array<{ role: string; content: string }>;
    // Exactly one summary message — the new one, at the head.
    expect(head.role).toBe('developer');
    expect(head.content).toContain('SECOND-SUMMARY');
    // No prior summary text or marker anywhere in the kept messages.
    for (const message of rest) {
      expect(message.content).not.toContain(COMPACTION_SUMMARY_MARKER);
      expect(message.content).not.toContain('FIRST-SUMMARY');
    }
    // The kept user messages are the genuine user words, verbatim.
    expect(
      rest.some((m) => m.role === 'user' && m.content.includes('please fix the flaky test')),
    ).toBe(true);
  });

  it('still compacts when the consumer abandons the stream mid-run', async () => {
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: seededMessages() });
    // cycle 1 (parent) crosses the threshold; the Phase 7.1 mid-run trigger
    // then compacts at the top of the next loop iteration — inside the live
    // stream, so it emits a `compaction` event. The consumer abandons on that
    // event; the compaction (PreCompact + PostCompact + the state rewrite) has
    // already happened. (With the mid-run trigger consuming the signal, the
    // `finally` fallback — guarded by `autoCompactAttempted` — is the
    // defensive net for the no-event abandon path; here the mid-run path runs.)
    state.fixtureQueue = [parentFixture(), compactFixture('ABANDON-SUMMARY')];

    async function* twoInputs(): AsyncIterable<{ content: string }> {
      yield { content: 'first' };
      yield { content: 'second' };
    }

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: twoInputs(),
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
      onHook: (event) => hookEvents.push(event),
    });

    // Abandon the stream as soon as the mid-run compaction lands.
    for await (const ev of run) {
      if (ev.type === 'compaction') break;
    }

    // Compaction happened despite the abandon: hooks fired, state rewritten.
    expect(hookEvents).toContain('PreCompact');
    expect(hookEvents).toContain('PostCompact');
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('ABANDON-SUMMARY');
  });

  it('caps the verbatim user-message keep set newest-first at 20k tokens', async () => {
    // The oldest user message alone (~25k tokens) blows the 20k budget and
    // must be skipped; the two newer small ones survive verbatim.
    const giant = { role: 'user', content: 'g'.repeat(100_000) };
    const messages = [
      giant,
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'small question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'small question two' },
      { role: 'assistant', content: 'answer two' },
    ];
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages });
    state.fixtureQueue = [compactFixture('CAP-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    await run.compact();

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    const contents = (persisted.messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents.some((c) => c === 'small question one')).toBe(true);
    expect(contents.some((c) => c === 'small question two')).toBe(true);
    expect(contents.some((c) => c.startsWith('gggg'))).toBe(false);
  });
});
