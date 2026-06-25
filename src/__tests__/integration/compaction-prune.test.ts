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

import {
  OpenRouterAgentRun,
  PRUNE_CLEARED_MARKER,
  PRUNE_STORED_MARKER_PREFIX,
  readTranscript,
} from '../../index.js';
import type { HookEvent, HookPayload } from '../../index.js';

const SESSION = 'integration-compaction-prune';

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

const u = (content: string) => ({ type: 'message', role: 'user', content });
const a = (content: string) => ({ type: 'message', role: 'assistant', content });
const fc = (callId: string, name: string) => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: '{}',
});
const fco = (callId: string, output: string) => ({
  type: 'function_call_output',
  call_id: callId,
  output,
});

/**
 * A history whose OLD tool output (c1) is prunable under the defaults:
 * the newest output (c2, 170k chars ≈ 42.5k tokens) consumes the 40k-token
 * recency protection, the last 2 turns are protected, and the old output
 * (c1, `oldSize` chars) reclaims ≥ the 20k-token minimum when ≥ 80k chars.
 */
function prunableHistory(opts: { oldTool?: string; oldSize?: number } = {}): unknown[] {
  const oldTool = opts.oldTool ?? 'read_file';
  const oldSize = opts.oldSize ?? 100_000;
  return [
    u('start the investigation'),
    fc('c1', oldTool),
    fco('c1', 'x'.repeat(oldSize)),
    a('analyzed the file'),
    u('keep going'),
    fc('c2', 'read_file'),
    fco('c2', 'y'.repeat(170_000)),
    a('done with the second file'),
    u('wrap it up'),
    a('all done'),
  ];
}

async function seedState(opts: {
  logsRoot: string;
  sessionId: string;
  messages: unknown[];
  previousResponseId?: string;
}): Promise<string> {
  const dir = join(opts.logsRoot, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      id: opts.sessionId,
      messages: opts.messages,
      ...(opts.previousResponseId !== undefined && {
        previousResponseId: opts.previousResponseId,
      }),
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
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-prune-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('integration: Phase 7.4 tool-output prune tier', () => {
  it('prunes re-derivable tool output in place and SKIPS the summarizer when back under threshold', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
      previousResponseId: 'resp-stale-chain',
    });
    state.fixtureQueue = [parentFixture()];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      // Seed ≈ 271k chars; after pruning c1 (100k chars) it falls to ≈ 171k —
      // back under this threshold, so the summarizer is never called.
      compactionThreshold: 200_000,
      onHook: (event, payload) => hookEvents.push({ event, payload }),
    });
    for await (const _ of run) void _;

    // Only the parent call — the prune reclaimed enough to skip compaction.
    expect(state.callModelArgs.length).toBe(1);
    expect(hookEvents.some((h) => h.event === 'PreCompact')).toBe(false);

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    // Skeleton intact: same item count, function_call survives, call_ids kept.
    expect(persisted.messages.length).toBe(10);
    expect(persisted.messages[1]).toEqual(fc('c1', 'read_file'));
    expect(persisted.messages[2].call_id).toBe('c1');
    // Old re-derivable output cleared in place; recent output untouched.
    expect(persisted.messages[2].output).toBe(PRUNE_CLEARED_MARKER);
    expect(persisted.messages[6].output).toBe('y'.repeat(170_000));
    // The prefix was rewritten → stale response chain cleared.
    expect(persisted.previousResponseId).toBeUndefined();

    // Observability: Notification hook + transcript record.
    const notification = hookEvents.find((h) => h.event === 'Notification');
    expect(notification).toBeDefined();
    const payload = notification!.payload as Extract<HookPayload, { event: 'Notification' }>;
    expect(payload.message).toBe('tool_outputs_pruned');
    expect(payload.level).toBe('info');
    expect(payload.context).toMatchObject({ prunedCount: 1, offloadedCount: 0 });

    const records = [];
    for await (const record of readTranscript(logsRoot, SESSION)) records.push(record);
    const prune = records.find((r) => r.kind === 'prune');
    expect(prune).toMatchObject({
      kind: 'prune',
      prunedCount: 1,
      reclaimedTokensEstimate: 25_000,
      offloadedCount: 0,
    });
  });

  it('compacts AFTER the prune when the history is still over the threshold', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
    });
    state.fixtureQueue = [parentFixture(), compactFixture('POST-PRUNE-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      // Even after reclaiming 100k chars the history (~171k) stays over.
      compactionThreshold: 50_000,
      keepRecentTurns: 1,
    });
    for await (const _ of run) void _;

    // parent + summarizer — prune alone was not enough.
    expect(state.callModelArgs.length).toBe(2);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('POST-PRUNE-SUMMARY');
  });

  it('offloads non-re-derivable tool output to disk with a stored-at marker', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory({ oldTool: 'web_probe' }),
    });
    state.fixtureQueue = [parentFixture()];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 200_000,
      onHook: (event, payload) => hookEvents.push({ event, payload }),
    });
    for await (const _ of run) void _;

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    const marker: string = persisted.messages[2].output;
    expect(marker.startsWith(PRUNE_STORED_MARKER_PREFIX)).toBe(true);
    const storedPath = marker.slice(PRUNE_STORED_MARKER_PREFIX.length, -1);
    expect(storedPath).toContain(join(SESSION, 'pruned'));
    // The original bytes are recoverable from disk.
    expect(await readFile(storedPath, 'utf-8')).toBe('x'.repeat(100_000));

    const payload = hookEvents.find((h) => h.event === 'Notification')!.payload as Extract<
      HookPayload,
      { event: 'Notification' }
    >;
    expect(payload.context).toMatchObject({ prunedCount: 1, offloadedCount: 1 });
  });

  it('honors the pruneProtectedTools skip-list', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory({ oldTool: 'web_probe' }),
    });
    state.fixtureQueue = [parentFixture(), compactFixture('PROTECTED-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 200_000,
      keepRecentTurns: 1,
      pruneProtectedTools: ['web_probe'],
    });
    for await (const _ of run) void _;

    // Nothing prunable → still over threshold → the summarizer ran instead.
    expect(state.callModelArgs.length).toBe(2);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    // The kept tail (keepRecentTurns: 1) preserves the protected output's turn
    // boundary out of scope here; the key assertion is no marker was written
    // anywhere in the rewritten history.
    const serialized = JSON.stringify(persisted.messages);
    expect(serialized).not.toContain(PRUNE_CLEARED_MARKER);
    expect(serialized).not.toContain(PRUNE_STORED_MARKER_PREFIX);
  });

  it('skips the prune when the reclaim falls below the 20k-token minimum', async () => {
    // The old output is large enough to escape the 40k recency protection
    // window math but reclaims only ~5k tokens — below the commit minimum.
    const messages = [
      u('start'),
      fc('c1', 'read_file'),
      fco('c1', 'x'.repeat(20_000)), // ~5k tokens
      a('ok'),
      u('next'),
      fc('c2', 'read_file'),
      fco('c2', 'y'.repeat(170_000)),
      a('ok2'),
      u('latest'),
      a('done'),
    ];
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages });
    state.fixtureQueue = [parentFixture()];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 500_000, // not crossed — prune-only path
      pruneThreshold: 100_000, // crossed (≈191k chars)
      onHook: (event) => hookEvents.push(event),
    });
    for await (const _ of run) void _;

    expect(hookEvents).not.toContain('Notification');
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[2].output).toBe('x'.repeat(20_000));
  });

  it('autoPrune: false goes straight to the summarizer', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
    });
    state.fixtureQueue = [parentFixture(), compactFixture('NO-PRUNE-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 200_000,
      keepRecentTurns: 1,
      autoPrune: false,
    });
    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(2);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(JSON.stringify(persisted.messages)).not.toContain(PRUNE_CLEARED_MARKER);
  });

  it('pruneThreshold is token-denominated when a tokenCounter is wired', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
    });
    state.fixtureQueue = [parentFixture()];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000_000, // never crossed
      pruneThreshold: 60_000, // TOKENS under the counter below
      tokenCounter: () => 70_000, // ≥ 60k → prune fires
    });
    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(1);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[2].output).toBe(PRUNE_CLEARED_MARKER);
  });

  it('a throwing tokenCounter falls back to the chars heuristic for the prune threshold', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
    });
    state.fixtureQueue = [parentFixture()];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000_000, // never crossed
      pruneThreshold: 100_000, // CHARS after the fallback (≈271k serialized)
      tokenCounter: () => {
        throw new Error('tokenizer exploded');
      },
      logger: (level, message) => logEntries.push({ level, message }),
    });
    for await (const _ of run) void _;

    expect(
      logEntries.some((l) => l.level === 'warn' && l.message.includes('tokenCounter threw')),
    ).toBe(true);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[2].output).toBe(PRUNE_CLEARED_MARKER);
  });

  it('falls back to clearing when the offload write fails (pruned path blocked)', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory({ oldTool: 'web_probe' }),
    });
    // Occupy the offload directory path with a FILE so mkdir recursive fails.
    await writeFile(join(logsRoot, SESSION, 'pruned'), 'not a directory');
    state.fixtureQueue = [parentFixture()];

    const logEntries: Array<{ level: string; message: string }> = [];
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 200_000,
      logger: (level, message) => logEntries.push({ level, message }),
      onHook: (event, payload) => hookEvents.push({ event, payload }),
    });
    for await (const _ of run) void _;

    expect(
      logEntries.some(
        (l) => l.level === 'warn' && l.message.includes('Failed to offload pruned tool output'),
      ),
    ).toBe(true);
    const persisted = JSON.parse(await readFile(join(logsRoot, SESSION, 'state.json'), 'utf-8'));
    // Cleared, not stored — and the prune still committed.
    expect(persisted.messages[2].output).toBe(PRUNE_CLEARED_MARKER);
    const payload = hookEvents.find((h) => h.event === 'Notification')!.payload as Extract<
      HookPayload,
      { event: 'Notification' }
    >;
    expect(payload.context).toMatchObject({ prunedCount: 1, offloadedCount: 0 });
  });

  it('the lower pruneThreshold triggers a prune-only pass below the compaction threshold', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: prunableHistory(),
    });
    state.fixtureQueue = [parentFixture()];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000_000, // never crossed
      pruneThreshold: 100_000, // crossed (≈271k chars)
    });
    for await (const _ of run) void _;

    // No summarizer call — prune only.
    expect(state.callModelArgs.length).toBe(1);
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[2].output).toBe(PRUNE_CLEARED_MARKER);
  });
});
