// Integration test for Phase 4.5: OpenRouterAgentRun.fork() and the
// parentSessionId construction option. Drives the run against the
// single-turn-no-usage fixture so the state.json write path is exercised
// through callModel's StateAccessor plumbing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixture, type MockState } from './mock-openrouter.js';

const { state } = vi.hoisted(() => {
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

vi.mock('../../tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from '../../index.js';
import type { AgentCoreEvent } from '../../index.js';

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

describe('integration: OpenRouterAgentRun.fork() (Phase 4.5)', () => {
  it('forks a persisted run: copies state.json + stamps parentSessionId', async () => {
    const sessionId = 'fork-persisted-src';
    const logsRoot = await mkdtemp(join(tmpdir(), 'fork-persisted-'));
    try {
      // Hand-write a state.json so the fork has something to copy; the
      // fixture's callModel never calls StateAccessor.save itself.
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(logsRoot, sessionId), { recursive: true });
      await writeFile(
        join(logsRoot, sessionId, 'state.json'),
        JSON.stringify({ previousResponseId: 'pre-fork' }, null, 2),
      );

      state.fixture = loadFixture('single-turn-no-usage');
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int-test',
        sessionId,
        prompt: 'first turn',
        logsRoot,
        tools: [],
      });
      await collect(run);

      const { sessionId: forkedId } = await run.fork();

      const forkedStatePath = join(logsRoot, forkedId, 'state.json');
      await expect(access(forkedStatePath)).resolves.toBeUndefined();
      const forkedState = JSON.parse(await readFile(forkedStatePath, 'utf-8'));
      expect(forkedState.previousResponseId).toBe('pre-fork');

      const forkedSession = JSON.parse(
        await readFile(join(logsRoot, forkedId, 'session.json'), 'utf-8'),
      );
      expect(forkedSession.parentSessionId).toBe(sessionId);
      expect(forkedSession.sessionId).toBe(forkedId);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it('rejects fork() when constructed with persistSession: false', async () => {
    const sessionId = 'fork-ephemeral-src';
    const logsRoot = await mkdtemp(join(tmpdir(), 'fork-ephemeral-'));
    try {
      state.fixture = loadFixture('single-turn-no-usage');
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int-test',
        sessionId,
        prompt: 'in-memory only',
        logsRoot,
        persistSession: false,
        tools: [],
      });
      await collect(run);

      await expect(run.fork()).rejects.toThrowError(
        `cannot fork in-memory session: ${sessionId} has no on-disk state at ${join(logsRoot, sessionId, 'state.json')}`,
      );
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it('surfaces parentSessionId on session_started + writes it to session.json', async () => {
    const sessionId = 'fork-child-session';
    const parentSessionId = 'parent-uuid-fixture';
    const logsRoot = await mkdtemp(join(tmpdir(), 'fork-child-'));
    try {
      state.fixture = loadFixture('single-turn-no-usage');
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int-test',
        sessionId,
        prompt: 'child run',
        logsRoot,
        parentSessionId,
        tools: [],
      });

      const events = await collect(run);
      const sessionStarted = events.find((e) => e.type === 'session_started');
      expect(sessionStarted).toBeDefined();
      expect(sessionStarted).toEqual({
        type: 'session_started',
        sessionId,
        parentSessionId,
      });

      const sessionJson = JSON.parse(
        await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8'),
      );
      expect(sessionJson.parentSessionId).toBe(parentSessionId);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it('omits parentSessionId from session_started + session.json for root sessions', async () => {
    const sessionId = 'fork-root-session';
    const logsRoot = await mkdtemp(join(tmpdir(), 'fork-root-'));
    try {
      state.fixture = loadFixture('single-turn-no-usage');
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int-test',
        sessionId,
        prompt: 'root run',
        logsRoot,
        tools: [],
      });
      const events = await collect(run);

      const sessionStarted = events.find((e) => e.type === 'session_started');
      expect(sessionStarted).toEqual({ type: 'session_started', sessionId });
      // Belt-and-suspenders: confirm the field is genuinely absent (not just undefined).
      expect(Object.prototype.hasOwnProperty.call(sessionStarted, 'parentSessionId')).toBe(false);

      const sessionJson = JSON.parse(
        await readFile(join(logsRoot, sessionId, 'session.json'), 'utf-8'),
      );
      expect(Object.prototype.hasOwnProperty.call(sessionJson, 'parentSessionId')).toBe(false);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});
