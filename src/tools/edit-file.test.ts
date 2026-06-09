import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { editFileTool } from './edit-file.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '../../.test-tmp/edit-file');

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const tool = editFileTool();
const execute = tool.function.execute as (params: {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}) => Promise<{ path: string; replaced: boolean; replacedCount: number }>;

describe('edit_file tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('edit_file');
  });

  it('replaces a unique string', async () => {
    const filePath = join(TMP, 'edit.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    const result = await execute({
      path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    expect(result.replaced).toBe(true);
    expect(result.replacedCount).toBe(1);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('goodbye world');
  });

  it('replaces every occurrence when replace_all is true', async () => {
    const filePath = join(TMP, 'replace-all.txt');
    await writeFile(filePath, 'aaa bbb aaa bbb aaa', 'utf-8');

    const result = await execute({
      path: filePath,
      old_string: 'aaa',
      new_string: 'XXX',
      replace_all: true,
    });

    expect(result.replaced).toBe(true);
    expect(result.replacedCount).toBe(3);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('XXX bbb XXX bbb XXX');
  });

  it('replace_all still throws when old_string does not appear at all', async () => {
    const filePath = join(TMP, 'replace-all-missing.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    await expect(
      execute({
        path: filePath,
        old_string: 'missing',
        new_string: 'x',
        replace_all: true,
      }),
    ).rejects.toThrow('old_string not found');
  });

  it('replace_all bypasses the uniqueness check (single-occurrence still works)', async () => {
    const filePath = join(TMP, 'replace-all-single.txt');
    await writeFile(filePath, 'foo bar baz', 'utf-8');

    const result = await execute({
      path: filePath,
      old_string: 'bar',
      new_string: 'BAR',
      replace_all: true,
    });

    expect(result.replacedCount).toBe(1);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('foo BAR baz');
  });

  it('throws when old_string is not found', async () => {
    const filePath = join(TMP, 'missing.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    await expect(
      execute({ path: filePath, old_string: 'nonexistent', new_string: 'x' }),
    ).rejects.toThrow('old_string not found');
  });

  it('throws when old_string appears multiple times', async () => {
    const filePath = join(TMP, 'dupe.txt');
    await writeFile(filePath, 'aaa bbb aaa', 'utf-8');

    await expect(execute({ path: filePath, old_string: 'aaa', new_string: 'ccc' })).rejects.toThrow(
      'found 2 times',
    );
  });

  it('throws message includes the replace_all hint when uniqueness check trips', async () => {
    const filePath = join(TMP, 'hint.txt');
    await writeFile(filePath, 'aa bb aa cc aa', 'utf-8');
    await expect(execute({ path: filePath, old_string: 'aa', new_string: 'ZZ' })).rejects.toThrow(
      /replace_all: true/,
    );
  });

  it('handles multi-line replacements', async () => {
    const filePath = join(TMP, 'multiline.txt');
    await writeFile(filePath, 'line1\nline2\nline3', 'utf-8');

    await execute({
      path: filePath,
      old_string: 'line2\nline3',
      new_string: 'replaced',
    });

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nreplaced');
  });

  it('throws when file does not exist', async () => {
    await expect(
      execute({ path: join(TMP, 'nope.txt'), old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow();
  });

  it('auto-checkpoints before editing when ctx.checkpoint is true', async () => {
    const { listCheckpoints, restoreCheckpoint } = await import('../checkpoints.js');
    const sessionId = 'edit-cp';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'snap.txt');
    await writeFile(filePath, 'aaa BBB ccc', 'utf-8');

    const ctxTool = editFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true,
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, old_string: 'BBB', new_string: 'ZZZ' });
    expect(await readFile(filePath, 'utf-8')).toBe('aaa ZZZ ccc');

    const list = await listCheckpoints(sessionId, logsRoot);
    expect(list).toHaveLength(1);
    await restoreCheckpoint(list[0]!.checkpointId, sessionId, logsRoot);
    expect(await readFile(filePath, 'utf-8')).toBe('aaa BBB ccc');
  });

  it('logs a warn and skips checkpoint when persistSession is false', async () => {
    const { vi } = await import('vitest');
    const { listCheckpoints } = await import('../checkpoints.js');
    const sessionId = 'edit-eph';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'eph.txt');
    await writeFile(filePath, 'a b c', 'utf-8');

    const logger = vi.fn();
    const ctxTool = editFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true,
      persistSession: false,
      logger,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, old_string: 'b', new_string: 'Z' });

    expect(await readFile(filePath, 'utf-8')).toBe('a Z c');
    expect(await listCheckpoints(sessionId, logsRoot)).toEqual([]);
    const warns = logger.mock.calls.filter((c) => c[0] === 'warn');
    expect(warns.some((c) => /persistSession is false/.test(c[1] ?? ''))).toBe(true);
  });

  it('silently skips checkpoint when checkpoint:true but sessionId/logsRoot absent', async () => {
    const filePath = join(TMP, 'no-ctx.txt');
    await writeFile(filePath, 'one two three', 'utf-8');
    const ctxTool = editFileTool({ cwd: '.', checkpoint: true });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await exec({ path: filePath, old_string: 'two', new_string: 'TWO' });
    expect(await readFile(filePath, 'utf-8')).toBe('one TWO three');
  });

  it('does NOT snapshot when edit_file fails validation (old_string not found)', async () => {
    const { listCheckpoints } = await import('../checkpoints.js');
    const sessionId = 'edit-cp-fail';
    const logsRoot = join(TMP, 'logs');
    const filePath = join(TMP, 'novalidate.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    const ctxTool = editFileTool({
      cwd: '.',
      sessionId,
      logsRoot,
      checkpoint: true,
      persistSession: true,
    });
    const exec = ctxTool.function.execute as (i: unknown) => Promise<unknown>;
    await expect(exec({ path: filePath, old_string: 'nope', new_string: 'x' })).rejects.toThrow();

    // Validation happens before checkpointing, so no snapshot was written.
    expect(await listCheckpoints(sessionId, logsRoot)).toHaveLength(0);
  });
});
