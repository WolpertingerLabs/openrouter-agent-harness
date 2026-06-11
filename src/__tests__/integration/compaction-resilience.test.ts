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

import { OpenRouterAgentRun, COMPACTION_FAILURE_LIMIT } from '../../index.js';
import type { HookEvent, HookPayload } from '../../index.js';

const SESSION = 'integration-compaction-resilience';

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

function overflowFixture(): Fixture {
  return {
    name: 'compact-overflow',
    steps: [{ type: 'throw', message: 'This input exceeds the maximum context length' }],
  };
}

function failingFixture(): Fixture {
  return {
    name: 'compact-fails',
    steps: [{ type: 'throw', message: 'mock summarizer failure (not overflow)' }],
  };
}

async function seedState(opts: {
  logsRoot: string;
  sessionId: string;
  messages: unknown[];
  compactionFailureCount?: number;
}): Promise<string> {
  const dir = join(opts.logsRoot, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  await writeFile(
    path,
    JSON.stringify({
      id: opts.sessionId,
      messages: opts.messages,
      ...(opts.compactionFailureCount !== undefined && {
        compactionFailureCount: opts.compactionFailureCount,
      }),
      status: 'complete',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return path;
}

const longMessages = (n = 8, size = 200): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: String.fromCharCode(97 + (i % 26)).repeat(size),
  }));

let logsRoot: string;

beforeEach(async () => {
  state.fixture = null;
  state.fixtureQueue = [];
  state.ctorArgs.length = 0;
  state.callModelArgs.length = 0;
  state.pausedGate = null;
  state.constructorThrows = null;
  logsRoot = await mkdtemp(join(tmpdir(), 'compaction-resilience-'));
});

afterEach(async () => {
  await rm(logsRoot, { recursive: true, force: true });
});

describe('integration: Phase 7.3 summarizer resilience', () => {
  it('drop-oldest trim-retry: a context-overflow 400 retries with a shorter input and succeeds', async () => {
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });
    state.fixtureQueue = [parentFixture(), overflowFixture(), compactFixture('RETRY-SUMMARY')];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
      logger: (level, message) => logEntries.push({ level, message }),
    });
    for await (const _ of run) void _;

    // parent + failed summarize + retried summarize = 3 callModel calls.
    expect(state.callModelArgs.length).toBe(3);
    const firstInput = (state.callModelArgs[1] as { input: string }).input;
    const retryInput = (state.callModelArgs[2] as { input: string }).input;
    expect(typeof firstInput).toBe('string');
    // The retry dropped the oldest quarter — strictly shorter input.
    expect(retryInput.length).toBeLessThan(firstInput.length);
    // The rendered transcript is role-labelled, not JSON.
    expect(firstInput).toMatch(/^user: /);

    const retryLog = logEntries.find((l) => l.message.includes('Compaction summarizer overflowed'));
    expect(retryLog?.level).toBe('warn');

    // The compaction ultimately succeeded and rewrote state.
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('RETRY-SUMMARY');
    expect(persisted.compactionFailureCount).toBeUndefined();
  });

  it('caps the summarizer input to the model window budget BEFORE the first attempt', async () => {
    // 2000-token window → budget max(500, 2000−20000) = 500 tokens = 2000
    // chars. The seeded transcript renders far larger, so the pre-trim loop
    // must drop oldest items until the input fits.
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages(16, 400) });
    state.fixtureQueue = [parentFixture(), compactFixture('BUDGET-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      model: 'tiny/model',
      modelContextWindows: { 'tiny/model': 2_000 },
      compactionThreshold: 100,
      keepRecentTurns: 1,
    });
    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(2);
    const input = (state.callModelArgs[1] as { input: string }).input;
    expect(input.length).toBeLessThanOrEqual(2_000);
  });

  it('non-overflow summarizer errors are NOT retried', async () => {
    await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });
    state.fixtureQueue = [parentFixture(), failingFixture(), compactFixture('NEVER-USED')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
    });
    for await (const _ of run) void _;

    // parent + ONE failed summarize — no retry call consumed the queue.
    expect(state.callModelArgs.length).toBe(2);
  });

  it('inflation check: a summary that grows the history is rejected and the original state preserved', async () => {
    const original = longMessages(4, 50);
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: original });
    // The "summary" is far larger than the entire original history.
    state.fixtureQueue = [parentFixture(), compactFixture('X'.repeat(5_000))];

    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
      logger: (level, message) => logEntries.push({ level, message }),
    });
    for await (const _ of run) void _;

    // Auto path swallowed + logged the failure; original messages intact.
    // Stacked on Card 7.1: a single-input run that crosses the threshold
    // compacts at the loop top of the (input-exhausting) next iteration, so
    // the swallowed inflation failure surfaces on the mid-run channel rather
    // than the run-end one — either way it is an error-level auto failure.
    expect(
      logEntries.find(
        (l) =>
          l.message === 'Auto-compaction failed' || l.message === 'Mid-run auto-compaction failed',
      )?.level,
    ).toBe('error');
    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages).toEqual(original);
    // The failed attempt was recorded for the breaker.
    expect(persisted.compactionFailureCount).toBe(1);
  });

  it(`circuit breaker: opens after ${COMPACTION_FAILURE_LIMIT} consecutive auto failures and skips the summarizer`, async () => {
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });

    // Three runs whose summarizer call fails each time.
    for (let i = 0; i < COMPACTION_FAILURE_LIMIT; i++) {
      state.fixtureQueue = [parentFixture(), failingFixture()];
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-test',
        sessionId: SESSION,
        prompt: 'continue',
        logsRoot,
        compactionThreshold: 100,
        keepRecentTurns: 1,
      });
      for await (const _ of run) void _;
      const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
      expect(persisted.compactionFailureCount).toBe(i + 1);
    }

    // Fourth run: the breaker is open — no summarizer call, Notification +
    // logger error fired, run completes normally (un-compacted).
    state.fixtureQueue = [parentFixture()];
    const hookEvents: Array<{ event: HookEvent; payload: HookPayload }> = [];
    const logEntries: Array<{ level: string; message: string }> = [];
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
      onHook: (event, payload) => hookEvents.push({ event, payload }),
      logger: (level, message) => logEntries.push({ level, message }),
    });
    let status = '';
    for await (const ev of run) {
      if (ev.type === 'stream_complete') status = ev.status;
    }

    expect(status).toBe('success');
    // Only the parent call this run — the summarizer was never invoked.
    const compactCalls = (state.callModelArgs as Array<{ sessionId: string }>).filter((a) =>
      a.sessionId.startsWith(`${SESSION}:compact:`),
    );
    expect(compactCalls.length).toBe(COMPACTION_FAILURE_LIMIT);
    expect(hookEvents.some((h) => h.event === 'PreCompact')).toBe(false);
    const notification = hookEvents.find((h) => h.event === 'Notification');
    expect(notification).toBeDefined();
    const payload = notification!.payload as Extract<HookPayload, { event: 'Notification' }>;
    expect(payload.message).toBe('auto_compaction_breaker_open');
    expect(payload.level).toBe('error');
    expect(logEntries.find((l) => l.message.includes('circuit breaker open'))?.level).toBe('error');
  });

  it('manual compact() bypasses the open breaker and resets the counter on success', async () => {
    const statePath = await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: longMessages(),
      compactionFailureCount: COMPACTION_FAILURE_LIMIT + 2,
    });
    state.fixtureQueue = [compactFixture('MANUAL-RESET-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    await run.compact();

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.messages[0].content).toContain('MANUAL-RESET-SUMMARY');
    expect(persisted.compactionFailureCount).toBeUndefined();
  });

  it('manual compact() failures do NOT count toward the breaker', async () => {
    const statePath = await seedState({ logsRoot, sessionId: SESSION, messages: longMessages() });
    state.fixtureQueue = [failingFixture()];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'never iterated',
      logsRoot,
      keepRecentTurns: 1,
    });
    await expect(run.compact()).rejects.toThrow('mock summarizer failure');

    const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(persisted.compactionFailureCount).toBeUndefined();
  });

  it('summarizer input strips encrypted reasoning content and image payloads', async () => {
    const blob = 'SECRET_ENCRYPTED_BLOB_' + 'Q'.repeat(300);
    await seedState({
      logsRoot,
      sessionId: SESSION,
      messages: [
        { role: 'user', content: 'investigate the flaky test '.repeat(20) },
        {
          type: 'reasoning',
          encrypted_content: blob,
          summary: [{ type: 'summary_text', text: 'considering the race condition' }],
        },
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"flaky.test.ts"}',
        },
        { type: 'function_call_output', call_id: 'c1', output: 'test file contents here' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'see screenshot' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAABBBB' },
          ],
        },
        { role: 'assistant', content: 'looked at the screenshot' },
        // Trailing turn so that under Card 7.2's turn-boundary partition the
        // single kept turn (keepRecentTurns: 1) is THIS one — the encrypted
        // reasoning + image turns above fall into the summarized prefix, which
        // is what this test asserts gets stripped/marked in the summarizer
        // input.
        { role: 'user', content: 'now fix it' },
        { role: 'assistant', content: 'final words' },
      ],
    });
    state.fixtureQueue = [parentFixture(), compactFixture('CLEAN-SUMMARY')];

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: SESSION,
      prompt: 'continue',
      logsRoot,
      compactionThreshold: 100,
      keepRecentTurns: 1,
    });
    for await (const _ of run) void _;

    expect(state.callModelArgs.length).toBe(2);
    const input = (state.callModelArgs[1] as { input: string }).input;
    expect(input).not.toContain('SECRET_ENCRYPTED_BLOB_');
    expect(input).not.toContain('encrypted_content');
    expect(input).not.toContain('AAAABBBB');
    expect(input).toContain('[reasoning] considering the race condition');
    expect(input).toContain('[tool call] read_file({"path":"flaky.test.ts"})');
    expect(input).toContain('[tool result] test file contents here');
    expect(input).toContain('[image]');
  });
});
