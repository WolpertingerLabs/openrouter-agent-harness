// Integration test for Phase 4.6: end-to-end auto-checkpointing through the
// agent's tool-context plumbing. Verifies the persistSession: false no-op
// path (test #9 in the issue body).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixture, type MockState, type Fixture } from './mock-openrouter.js';

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
import { listCheckpoints } from '../../checkpoints.js';
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

function fixtureForWrite(filePath: string): Fixture {
  const raw = loadFixture('single-write-file');
  // Deep-clone + substitute the PLACEHOLDER path everywhere it appears.
  const cloned = JSON.parse(JSON.stringify(raw)) as Fixture;
  for (const step of cloned.steps) {
    if (step.type === 'yield') {
      const item = (step.event as { item?: { arguments?: string } }).item;
      if (item?.arguments) {
        item.arguments = item.arguments.replace(/PLACEHOLDER/g, filePath);
      }
    } else if (step.type === 'tool_execute') {
      const input = step.input as { path?: string };
      if (input.path === 'PLACEHOLDER') input.path = filePath;
    }
  }
  return cloned;
}

describe('integration: Phase 4.6 file checkpointing', () => {
  it('persistSession: false → write succeeds, no checkpoints dir, warn log emitted', async () => {
    const sessionId = 'cp-ephemeral';
    const logsRoot = await mkdtemp(join(tmpdir(), 'cp-ephemeral-'));
    try {
      const target = join(logsRoot, 'work', 'live.txt');
      await writeFile(target.replace(/\/live\.txt$/, '/.keep'), '', 'utf-8').catch(() => undefined);
      // Pre-create the file so write_file just overwrites it.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(logsRoot, 'work'), { recursive: true });
      await writeFile(target, 'baseline', 'utf-8');

      state.fixture = fixtureForWrite(target);

      const logger = vi.fn();
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int',
        sessionId,
        prompt: 'overwrite the file',
        logsRoot,
        persistSession: false,
        checkpoint: true,
        logger,
      });
      await collect(run);

      // Write went through.
      expect(await readFile(target, 'utf-8')).toBe('mutated');

      // No checkpoints/ subdir under the session — the directory was never
      // created because the no-op short-circuited before createCheckpoint().
      await expect(access(join(logsRoot, sessionId, 'checkpoints'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await listCheckpoints(sessionId, logsRoot)).toEqual([]);

      // Warn log with the documented message.
      const warns = logger.mock.calls.filter((c) => c[0] === 'warn');
      expect(warns.some((c) => /persistSession is false/.test(c[1] ?? ''))).toBe(true);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it('persistSession: true + checkpoint: true → snapshot written before write', async () => {
    const sessionId = 'cp-persisted';
    const logsRoot = await mkdtemp(join(tmpdir(), 'cp-persisted-'));
    try {
      const target = join(logsRoot, 'work', 'live.txt');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(logsRoot, 'work'), { recursive: true });
      await writeFile(target, 'pristine', 'utf-8');

      state.fixture = fixtureForWrite(target);

      const run = new OpenRouterAgentRun({
        apiKey: 'sk-int',
        sessionId,
        prompt: 'snap then mutate',
        logsRoot,
        checkpoint: true,
      });
      await collect(run);

      expect(await readFile(target, 'utf-8')).toBe('mutated');

      const list = await listCheckpoints(sessionId, logsRoot);
      expect(list).toHaveLength(1);

      // The snapshot file is on disk under the session checkpoint dir.
      const cpDir = join(logsRoot, sessionId, 'checkpoints', list[0]!.checkpointId);
      const entries = await readdir(cpDir);
      expect(entries.some((e) => e.endsWith('.snapshot'))).toBe(true);
    } finally {
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});
