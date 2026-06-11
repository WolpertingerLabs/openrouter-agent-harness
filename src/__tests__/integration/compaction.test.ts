import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fixture, MockState } from './mock-openrouter.js';
import { createGate } from './mock-openrouter.js';

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

const SESSION = 'integration-compaction';

/** Trivial parent fixture: one turn, one text delta, one turn end, success. */
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

/**
 * Compaction fixture: yields a synthetic summary text via text_delta events.
 * Includes a non-text-delta event upfront so the event-filter branch in
 * `OpenRouterAgentRun.compact()` exercises both arms (matching + non-matching
 * `event.type`), and a deliberate empty-string delta to cover the
 * `typeof delta === 'string'` branch's "ignore falsy text" guard.
 */
function compactFixture(summary: string): Fixture {
  return {
    name: 'compact',
    steps: [
      { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
      // A delta event whose `delta` is a number — exercises the
      // `typeof delta === 'string'` false branch of the summary collector.
      {
        type: 'yield',
        event: { type: 'response.output_text.delta', delta: 42 } as unknown as Record<
          string,
          unknown
        >,
      },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: '' } },
      { type: 'yield', event: { type: 'response.output_text.delta', delta: summary } },
    ],
    response: {
      id: 'resp-compact',
      model: 'mock-model',
      usage: { cost: 0.0001, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      output: [],
    },
  };
}

interface SeedStateOptions {
  logsRoot: string;
  sessionId: string;
  messages: unknown[];
  previousResponseId?: string;
}

async function seedState(opts: SeedStateOptions): Promise<string> {
  const dir = join(opts.logsRoot, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      id: opts.sessionId,
      messages: opts.messages,
      ...(opts.previousResponseId !== undefined && { previousResponseId: opts.previousResponseId }),
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
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-test-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('integration: context compaction', () => {
  it('fires auto-compaction when threshold crossed and rewrites state', async () => {
    // Seed a pre-existing transcript that exceeds the configured threshold —
    // the mocked SDK does NOT itself write state.json (its callModel skips
    // the StateAccessor entirely), so we install the message history we
    // want the auto-trigger to see.
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
      { role: 'user', content: 'g'.repeat(100) },
      { role: 'assistant', content: 'h'.repeat(100) },
    ];
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages,
      previousResponseId: 'resp-stale-chain',
    });

    state.fixtureQueue = [parentFixture(), compactFixture('SUMMARY-OF-PRIOR-TURNS')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100, // well below the 8 * (100+overhead) of seed
      keepRecentTurns: 2,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    // Stream stays well-formed — no compaction-related events injected.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session_started');
    expect(types.at(-1)).toBe('stream_complete');
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');

    // PreCompact fires exactly once, between the run's PostToolUse events
    // and the SessionEnd / Stop bracket.
    const compactHooks = hookEvents.filter((h) => h.event === 'PreCompact');
    expect(compactHooks.length).toBe(1);
    const compactPayload = compactHooks[0].payload as Extract<HookPayload, { event: 'PreCompact' }>;
    expect(compactPayload.reason).toBe('auto');
    expect(compactPayload.keepRecentTurns).toBe(2);
    expect(Array.isArray(compactPayload.messages)).toBe(true);
    // 8 seeded - 2 keep = 6 in summarize
    expect((compactPayload.messages as unknown[]).length).toBe(6);

    const stopIdx = hookEvents.findIndex((h) => h.event === 'Stop');
    const preCompactIdx = hookEvents.findIndex((h) => h.event === 'PreCompact');
    const sessionEndIdx = hookEvents.findIndex((h) => h.event === 'SessionEnd');
    expect(preCompactIdx).toBeGreaterThan(-1);
    expect(preCompactIdx).toBeLessThan(sessionEndIdx);
    expect(sessionEndIdx).toBeLessThan(stopIdx);

    // The mock recorded TWO callModel invocations — the parent run, then the
    // isolated compaction sub-call with the `<session>:compact:<uuid>` id.
    expect(state.callModelArgs.length).toBe(2);
    const compactCallArgs = state.callModelArgs[1] as {
      sessionId: string;
      instructions: string;
      input: unknown;
    };
    expect(compactCallArgs.sessionId).toMatch(/^integration-compaction:compact:/);
    expect(compactCallArgs.instructions).toContain('context-compaction');
    expect(typeof compactCallArgs.input).toBe('string');

    // The persisted state.json was rewritten: leading summary message, then
    // the last 2 messages preserved verbatim, previousResponseId cleared.
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.previousResponseId).toBeUndefined();
    expect(persisted.messages.length).toBe(3); // [summary, ...last 2]
    expect(persisted.messages[0]).toMatchObject({
      type: 'message',
      role: 'developer',
    });
    expect(persisted.messages[0].content).toContain('SUMMARY-OF-PRIOR-TURNS');
    // Last two messages of the seed survive verbatim.
    expect(persisted.messages[1]).toEqual(longMessages[6]);
    expect(persisted.messages[2]).toEqual(longMessages[7]);
  });

  it('compaction callModel inherits the run-level `cacheControl` when set', async () => {
    // Compaction summarization prompts are exactly the kind of large
    // reusable prefix that benefits from auto prompt caching — the agent
    // threads the run's `cacheControl` into the isolated compaction call so
    // the summarizer can hit the same cache. Verify the field forwards.
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
    ];
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages });
    state.fixtureQueue = [parentFixture(), compactFixture('SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 2,
      cacheControl: { type: 'ephemeral' },
    });

    for await (const _ of run) void _;

    // Two callModel calls: parent run + compaction sub-call. Both should
    // carry the cacheControl directive verbatim.
    expect(state.callModelArgs.length).toBe(2);
    const parentArgs = state.callModelArgs[0] as {
      cacheControl?: { type: string; ttl?: string };
    };
    const compactArgs = state.callModelArgs[1] as {
      sessionId: string;
      cacheControl?: { type: string; ttl?: string };
    };
    expect(parentArgs.cacheControl).toEqual({ type: 'ephemeral' });
    expect(compactArgs.sessionId).toMatch(/^integration-compaction:compact:/);
    expect(compactArgs.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('compaction callModel has NO `cacheControl` field when the run did not set one', async () => {
    // Negative arm: omitted `cacheControl` → the compaction sub-call must
    // not carry the field at all (preserves prior behavior and covers the
    // false branch of the conditional spread).
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
    ];
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages });
    state.fixtureQueue = [parentFixture(), compactFixture('SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 2,
    });

    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(2);
    const parentArgs = state.callModelArgs[0] as Record<string, unknown>;
    const compactArgs = state.callModelArgs[1] as Record<string, unknown>;
    expect('cacheControl' in parentArgs).toBe(false);
    expect('cacheControl' in compactArgs).toBe(false);
  });

  it('does NOT auto-compact when threshold not crossed', async () => {
    // Seed a transcript well below the (default) threshold.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [{ role: 'user', content: 'short' }],
    });

    state.fixture = parentFixture();

    const hookEvents: Array<{ event: HookEvent }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000_000,
      onHook: (event) => {
        hookEvents.push({ event });
      },
    });

    for await (const _ of run) void _;

    // Only the parent call — no compaction sub-call.
    expect(state.callModelArgs.length).toBe(1);
    expect(hookEvents.find((h) => h.event === 'PreCompact')).toBeUndefined();
  });

  it('honours `autoCompact: false` (no auto-trigger even above threshold)', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(500) },
        { role: 'assistant', content: 'y'.repeat(500) },
        { role: 'user', content: 'z'.repeat(500) },
      ],
    });

    state.fixture = parentFixture();

    const hookEvents: Array<{ event: HookEvent }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      autoCompact: false,
      compactionThreshold: 50, // would otherwise trigger
      keepRecentTurns: 1,
      onHook: (event) => {
        hookEvents.push({ event });
      },
    });

    for await (const _ of run) void _;

    // No second callModel — the auto-trigger was suppressed.
    expect(state.callModelArgs.length).toBe(1);
    expect(hookEvents.find((h) => h.event === 'PreCompact')).toBeUndefined();
  });

  it('manual compact() works regardless of autoCompact and clears previousResponseId', async () => {
    const seedMessages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'third' },
    ];
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: seedMessages,
      previousResponseId: 'resp-to-clear',
    });

    // Only one callModel expected — the manual compact one. The agent's
    // iterate() is not driven in this test.
    state.fixtureQueue = [compactFixture('MANUAL-SUMMARY')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      autoCompact: false,
      keepRecentTurns: 1,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    await run.compact();

    expect(state.callModelArgs.length).toBe(1);
    const preCompact = hookEvents.find((h) => h.event === 'PreCompact');
    expect(preCompact).toBeDefined();
    const payload = preCompact!.payload as Extract<HookPayload, { event: 'PreCompact' }>;
    expect(payload.reason).toBe('manual');
    expect((payload.messages as unknown[]).length).toBe(4); // 5 - keepRecentTurns(1)

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.previousResponseId).toBeUndefined();
    expect(persisted.messages.length).toBe(2);
    expect(persisted.messages[0].role).toBe('developer');
    expect(persisted.messages[0].content).toContain('MANUAL-SUMMARY');
    expect(persisted.messages[1]).toEqual(seedMessages[4]);
  });

  it('logs and swallows summarizer failures during auto-compaction without breaking the stream', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(500) },
        { role: 'assistant', content: 'y'.repeat(500) },
        { role: 'user', content: 'z'.repeat(500) },
      ],
    });

    state.fixtureQueue = [
      parentFixture(),
      {
        name: 'compact-throws',
        steps: [{ type: 'throw', message: 'mock summarizer failure' }],
      },
    ];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 50,
      keepRecentTurns: 1,
      logger: (level, message) => {
        logEntries.push({ level, message });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    // Stream still completes cleanly — auto-compact swallowed the throw.
    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('success');

    // The logger captured the failure record.
    const failureLog = logEntries.find((l) => l.message === 'Auto-compaction failed');
    expect(failureLog).toBeDefined();
    expect(failureLog?.level).toBe('error');
  });

  it('compact() short-circuits when messages array is empty', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: [] });
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
    });
    await run.compact();
    expect(state.callModelArgs.length).toBe(0);
  });

  it('compact() short-circuits when persisted messages field is not an array', async () => {
    // Seed a state whose messages field is a string (the SDK accepts both
    // shapes per InputsUnion; the compaction heuristic skips strings).
    await mkdir(join(logsRoot, SESSION), { recursive: true });
    await writeFile(
      join(logsRoot, SESSION, 'state.json'),
      JSON.stringify({
        id: SESSION,
        messages: 'plain string input',
        status: 'complete',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
    });
    await run.compact();
    expect(state.callModelArgs.length).toBe(0);
  });

  it('auto-compaction fires even when the consumer break-s out on stream_complete (blocker 2)', async () => {
    // The consumer break-s the for-await on stream_complete instead of
    // draining — this used to short-circuit auto-compact because the trigger
    // sat in the `try` body AFTER the yield. Now it lives in the generator's
    // `finally`, so the generator's `return()` (called by `break`) still
    // runs it.
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
      { role: 'user', content: 'g'.repeat(100) },
      { role: 'assistant', content: 'h'.repeat(100) },
    ];
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages,
    });

    state.fixtureQueue = [parentFixture(), compactFixture('BREAK-PATH-SUMMARY')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 2,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    let sawComplete = false;
    for await (const ev of run) {
      if (ev.type === 'stream_complete') {
        sawComplete = true;
        break; // <-- the idiomatic early-break pattern under test
      }
    }
    expect(sawComplete).toBe(true);

    // Auto-compaction still fired despite the consumer breaking out.
    const preCompact = hookEvents.find((h) => h.event === 'PreCompact');
    expect(preCompact).toBeDefined();
    const payload = preCompact!.payload as Extract<HookPayload, { event: 'PreCompact' }>;
    expect(payload.reason).toBe('auto');

    // And the state file was rewritten with the new summary.
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages.length).toBe(3);
    expect(persisted.messages[0].role).toBe('developer');
    expect(persisted.messages[0].content).toContain('BREAK-PATH-SUMMARY');

    // SessionEnd / Stop still fire AFTER the auto-compact, as required.
    const preCompactIdx = hookEvents.findIndex((h) => h.event === 'PreCompact');
    const sessionEndIdx = hookEvents.findIndex((h) => h.event === 'SessionEnd');
    const stopIdx = hookEvents.findIndex((h) => h.event === 'Stop');
    expect(preCompactIdx).toBeLessThan(sessionEndIdx);
    expect(sessionEndIdx).toBeLessThan(stopIdx);
  });

  it('auto-compaction fires on max_turns exits, not only on success (blocker 1)', async () => {
    // maxTurns=1 + a fixture that emits a single turn (turnNumber=0) means
    // `deriveCompletionStatus` returns 'max_turns', not 'success'. The old
    // `status === 'success'` guard skipped this case; the new guard
    // (`status !== 'error'`) lets it through.
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
      { role: 'user', content: 'g'.repeat(100) },
      { role: 'assistant', content: 'h'.repeat(100) },
    ];
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages });

    state.fixtureQueue = [parentFixture(), compactFixture('MAX-TURNS-SUMMARY')];

    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      maxTurns: 1, // forces a 'max_turns' completion status
      compactionThreshold: 100,
      keepRecentTurns: 2,
      onHook: (event, payload) => {
        hookEvents.push({ event, payload });
      },
    });

    const events: AgentCoreEvent[] = [];
    for await (const ev of run) events.push(ev);

    const complete = events.at(-1) as Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expect(complete.status).toBe('max_turns');

    // Auto-compaction triggered for the max_turns exit.
    const preCompact = hookEvents.find((h) => h.event === 'PreCompact');
    expect(preCompact).toBeDefined();
    expect((preCompact!.payload as Extract<HookPayload, { event: 'PreCompact' }>).reason).toBe(
      'auto',
    );
  });

  it('compact() throws synchronously when called from outside while iterate() is in progress', async () => {
    // Seed a non-empty state so compact() would otherwise have work to do —
    // proves the guard fires BEFORE the (would-be) summarizer call.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
    });

    // Parent fixture pauses mid-stream on the shared gate. The compact
    // fixture is queued in case the post-iter compact() call needs it.
    const gate = createGate();
    state.pausedGate = gate;
    const pausingFixture: Fixture = {
      name: 'parent-paused',
      steps: [
        { type: 'yield', event: { type: 'turn.start', turnNumber: 0, timestamp: 1 } },
        { type: 'wait_until', signal: 'paused' },
        { type: 'yield', event: { type: 'turn.end', turnNumber: 0, timestamp: 2 } },
      ],
      response: {
        id: 'resp-parent',
        model: 'mock-model',
        usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        output: [],
      },
    };
    state.fixtureQueue = [pausingFixture, compactFixture('POST-ITER-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      autoCompact: false, // keep this test focused on the guard, not auto-trigger
      keepRecentTurns: 1,
    });

    // Drive the iterator manually so we can synchronously assert the throw
    // while the generator is mid-stream.
    const iter = run[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBeFalsy();

    await expect(run.compact()).rejects.toThrow(
      /Cannot call compact\(\) while iterate\(\) is in progress/,
    );

    // Release the gate and drain the rest of the stream so the generator's
    // finally clears #isIterating.
    gate.resolve();
    for (;;) {
      const { done } = await iter.next();
      if (done) break;
    }

    // After iter completes, a fresh compact() call works.
    await run.compact();
    const compactCalls = (state.callModelArgs as Array<{ sessionId: string }>).filter((a) =>
      a.sessionId.startsWith(`${SESSION}:compact:`),
    );
    expect(compactCalls.length).toBe(1);
  });

  it('auto-compact does not trip its own iter-race guard (auto-trigger from inside finally)', async () => {
    // The auto-trigger calls this.compact('auto') from inside iterate()'s
    // own finally. If #isIterating were still set, the auto-call would
    // throw on its own guard. Asserts the bootstrap-sequencing fix (clear
    // the flag BEFORE invoking compact('auto')).
    const longMessages = [
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) },
      { role: 'user', content: 'e'.repeat(100) },
      { role: 'assistant', content: 'f'.repeat(100) },
    ];
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages });

    state.fixtureQueue = [parentFixture(), compactFixture('NO-SELF-TRIP')];

    const logEntries: Array<{ level: string; message: string }> = [];
    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 2,
      logger: (level, message) => {
        logEntries.push({ level, message });
      },
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    expect(hookEvents).toContain('PreCompact');
    // Auto-compact did not crash on its own guard.
    expect(logEntries.find((l) => l.message === 'Auto-compaction failed')).toBeUndefined();
  });

  it('tokenCounter mode: triggers compaction at the token boundary and receives the canonical serialization', async () => {
    const seedMessages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
      { role: 'assistant', content: 'six' },
    ];
    await seedState({ logsRoot, sessionId: SESSION, messages: seedMessages });
    state.fixtureQueue = [parentFixture(), compactFixture('TOKEN-SUMMARY')];

    const counterArgs: string[] = [];
    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      // With a tokenCounter wired, compactionThreshold is TOKENS: counter
      // returns exactly the threshold → `>=` fires.
      compactionThreshold: 1_000,
      tokenCounter: (serialized) => {
        counterArgs.push(serialized);
        return 1_000;
      },
      keepRecentTurns: 2,
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    expect(hookEvents).toContain('PreCompact');
    expect(state.callModelArgs.length).toBe(2); // parent + compaction sub-call
    // The counter received the same serialization the char heuristic
    // measures: per-item JSON, concatenated (the mocked SDK never rewrites
    // the seeded state, so the post-run history is the seed verbatim).
    expect(counterArgs).toHaveLength(1);
    expect(counterArgs[0]).toBe(seedMessages.map((m) => JSON.stringify(m)).join(''));
  });

  it('tokenCounter mode: does NOT trigger one token below the threshold', async () => {
    // Char-wise this seed is far above the tiny char threshold a configured
    // 1_000 would mean — proving the TOKEN reinterpretation is in effect.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(5_000) },
        { role: 'assistant', content: 'y'.repeat(5_000) },
        { role: 'user', content: 'z'.repeat(5_000) },
      ],
    });
    state.fixture = parentFixture();

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 1_000,
      tokenCounter: () => 999,
      keepRecentTurns: 1,
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(1); // no compaction sub-call
    expect(hookEvents).not.toContain('PreCompact');
  });

  it('tokenCounter mode: derives the default TOKEN threshold from modelContextWindows overrides', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    state.fixtureQueue = [parentFixture(), compactFixture('OVERRIDE-SUMMARY')];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      // 'tiny/model' is unknown to the static table (would default to 128k →
      // threshold 102_400 tokens). The override teaches a 100-token window →
      // threshold floor(100 * 0.8) = 80; the counter's 80 crosses it.
      model: 'tiny/model',
      modelContextWindows: { 'tiny/model': 100 },
      tokenCounter: () => 80,
      keepRecentTurns: 1,
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    expect(hookEvents).toContain('PreCompact');
    expect(state.callModelArgs.length).toBe(2);
  });

  it('tokenCounter throw: logs a warn and falls back to the char heuristic for the check', async () => {
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'y'.repeat(200) },
        { role: 'user', content: 'z'.repeat(200) },
      ],
    });
    state.fixtureQueue = [parentFixture(), compactFixture('FALLBACK-SUMMARY')];

    const logEntries: Array<{ level: string; message: string }> = [];
    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      // Under the fallback, the configured threshold reads as CHARS again —
      // 100 chars is far below the ~600-char seed, so compaction fires.
      compactionThreshold: 100,
      tokenCounter: () => {
        throw new Error('tokenizer exploded');
      },
      keepRecentTurns: 1,
      logger: (level, message) => {
        logEntries.push({ level, message });
      },
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    const warn = logEntries.find((l) => l.message.includes('tokenCounter threw'));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe('warn');
    // The char fallback still fired the compaction.
    expect(hookEvents).toContain('PreCompact');
    expect(state.callModelArgs.length).toBe(2);
  });

  it('char mode honours modelContextWindows overrides for the derived default threshold', async () => {
    // ~30-char messages; override gives a 10-token window → char threshold
    // floor(10 * 4 * 0.8) = 32 — the seed crosses it. Without the override
    // the unknown model would default to 128k tokens (≈409k chars).
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'aaaa' },
        { role: 'assistant', content: 'bbbb' },
        { role: 'user', content: 'cccc' },
      ],
    });
    state.fixtureQueue = [parentFixture(), compactFixture('CHAR-OVERRIDE-SUMMARY')];

    const hookEvents: HookEvent[] = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      model: 'tiny/model',
      modelContextWindows: { 'tiny/model': 10 },
      keepRecentTurns: 1,
      onHook: (event) => {
        hookEvents.push(event);
      },
    });

    for await (const _ of run) void _;

    expect(hookEvents).toContain('PreCompact');
    expect(state.callModelArgs.length).toBe(2);
  });

  it('compact() is a no-op when there is no saved state or messages are short', async () => {
    // Case 1: no state file at all.
    const run1 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'never-existed',
      prompt: 'noop',
      logsRoot,
    });
    await run1.compact();
    expect(state.callModelArgs.length).toBe(0);

    // Case 2: state exists but messages shorter than keepRecentTurns.
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [{ role: 'user', content: 'one' }],
    });
    const run2 = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'noop',
      logsRoot,
      keepRecentTurns: 10,
    });
    await run2.compact();
    expect(state.callModelArgs.length).toBe(0);
  });
});
