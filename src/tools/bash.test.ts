import { describe, it, expect, vi } from 'vitest';
import { bashTool, MAX_TIMEOUT_MS, type BashResult } from './bash.js';

const tool = bashTool();
const execute = tool.function.execute as (params: {
  command: string;
  cwd?: string;
}) => Promise<BashResult>;

describe('bash tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('bash');
  });

  it('runs a command and returns stdout', async () => {
    const result = await execute({ command: 'echo hello' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.isError).toBeUndefined();
  });

  it('captures stderr', async () => {
    const result = await execute({ command: 'echo err >&2' });
    expect(result.stderr.trim()).toBe('err');
    expect(result.isError).toBeUndefined();
  });

  it('returns non-zero exit code on failure and flips isError', async () => {
    const result = await execute({ command: 'exit 42' });
    expect(result.exitCode).toBe(42);
    expect(result.isError).toBe(true);
  });

  it('respects cwd parameter', async () => {
    const result = await execute({ command: 'pwd', cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
  });

  it('handles commands with pipes', async () => {
    const result = await execute({ command: 'echo "a b c" | wc -w' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });

  it('marks cancelled: true and isError: true when aborted mid-execution; stderr is NOT suffixed', async () => {
    const controller = new AbortController();
    const cancelTool = bashTool({ cwd: '.', signal: controller.signal });
    const cancelExecute = cancelTool.function.execute as (params: {
      command: string;
    }) => Promise<BashResult>;

    setTimeout(() => controller.abort(), 50);
    const result = await cancelExecute({ command: "printf 'oops' >&2; sleep 5" });

    expect(result.cancelled).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // The structured `cancelled` field replaces the previous stderr suffix.
    expect(result.stderr).not.toContain('bash cancelled');
    expect(result.stderr).toContain('oops');
  });

  it('sets killSignal: "SIGTERM" when the child is killed by SIGTERM; stderr is NOT suffixed', async () => {
    const result = await execute({ command: "printf 'before' >&2; kill -TERM $$" });
    expect(result.killSignal).toBe('SIGTERM');
    expect(result.isError).toBe(true);
    expect(result.stderr).not.toContain('terminated by');
    expect(result.stderr).toContain('before');
  });

  it('sets killSignal: "SIGKILL" when the child is killed by SIGKILL', async () => {
    const result = await execute({ command: 'kill -KILL $$' });
    expect(result.killSignal).toBe('SIGKILL');
    expect(result.isError).toBe(true);
    expect(result.stderr).not.toContain('terminated by');
  });

  it('emits stderr from the error handler when spawn fails', async () => {
    const errTool = bashTool({ cwd: '/nonexistent-xyz-9999-claude-test' });
    const errExecute = errTool.function.execute as (params: {
      command: string;
    }) => Promise<BashResult>;
    const result = await errExecute({ command: 'echo hi' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
    expect(result.isError).toBe(true);
  });

  it('cancelled with empty stderr leaves stderr empty (no suffix prepended)', async () => {
    const controller = new AbortController();
    const cancelTool = bashTool({ cwd: '.', signal: controller.signal });
    const cancelExecute = cancelTool.function.execute as (params: {
      command: string;
    }) => Promise<BashResult>;

    setTimeout(() => controller.abort(), 50);
    const result = await cancelExecute({ command: 'sleep 5' });

    expect(result.cancelled).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('caps stdout/stderr at 1MB each and surfaces stdoutTruncated/stderrTruncated flags', async () => {
    const result = await execute({
      command:
        'node -e "for(let i=0;i<150;i++){process.stdout.write(\\"x\\".repeat(10000));process.stderr.write(\\"y\\".repeat(10000));}"',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 65536);
    expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024 + 65536);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('omits truncated flags when output fits under MAX_BUFFER', async () => {
    const result = await execute({ command: 'echo ok' });
    expect(result.stdoutTruncated).toBeUndefined();
    expect(result.stderrTruncated).toBeUndefined();
  });

  it('handles signals other than SIGTERM/SIGKILL via the default close path', async () => {
    const result = await execute({ command: 'kill -HUP $$' });
    expect(result.exitCode).not.toBe(0);
    expect(result.killSignal).toBeUndefined();
    expect(result.cancelled).toBeUndefined();
    expect(result.isError).toBe(true);
  });

  it('terminates a long-running command when timeout_ms elapses and sets timedOut: true', async () => {
    const timeoutExecute = tool.function.execute as (params: {
      command: string;
      timeout_ms?: number;
    }) => Promise<BashResult>;
    const result = await timeoutExecute({ command: 'sleep 5', timeout_ms: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.isError).toBe(true);
    // The kill signal that won the race is exposed structurally — no
    // substring matching on stderr required.
    expect(result.killSignal === 'SIGTERM' || result.killSignal === 'SIGKILL').toBe(true);
  });

  it('preserves the 30s default when timeout_ms is omitted (short commands complete normally)', async () => {
    const result = await execute({ command: 'echo ok' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.timedOut).toBeUndefined();
  });

  it('clamps timeout_ms over MAX_TIMEOUT_MS and emits a warn notification', async () => {
    const notify = vi.fn(async () => {});
    const clampTool = bashTool({ cwd: '.', notify });
    const clampExecute = clampTool.function.execute as (params: {
      command: string;
      timeout_ms?: number;
    }) => Promise<BashResult>;

    const result = await clampExecute({ command: 'echo clamped', timeout_ms: 700_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('clamped');

    expect(notify).toHaveBeenCalledTimes(1);
    const firstCall = notify.mock.calls[0] as unknown as [string, string, unknown];
    expect(firstCall[0]).toBe('warn');
    expect(firstCall[1]).toMatch(/clamping/i);
    expect(firstCall[2]).toEqual({ requestedMs: 700_000, effectiveMs: MAX_TIMEOUT_MS });
  });

  it('does NOT emit a warn notification when timeout_ms is at or below MAX_TIMEOUT_MS', async () => {
    const notify = vi.fn(async () => {});
    const okTool = bashTool({ cwd: '.', notify });
    const okExecute = okTool.function.execute as (params: {
      command: string;
      timeout_ms?: number;
    }) => Promise<BashResult>;

    await okExecute({ command: 'echo ok', timeout_ms: MAX_TIMEOUT_MS });
    expect(notify).not.toHaveBeenCalled();
  });

  it('accepts and ignores a description field (advisory only, no influence on output)', async () => {
    const result = await execute({
      command: 'echo hi',
      // description is forwarded via tool_call.input by the runtime; the
      // execute function must accept it without disrupting the command result.
      description: 'list files for context',
    } as unknown as { command: string });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.stdout).not.toContain('list files');
    expect(result.stderr).not.toContain('list files');
  });

  it('exports MAX_TIMEOUT_MS = 600_000 (10 minutes)', () => {
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });

  it('returns early with cancelled+isError when signal is already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedTool = bashTool({ cwd: '.', signal: controller.signal });
    const abortedExecute = abortedTool.function.execute as (params: {
      command: string;
    }) => Promise<BashResult>;
    const result = await abortedExecute({ command: 'echo hi' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bash cancelled before start');
    expect(result.cancelled).toBe(true);
    expect(result.isError).toBe(true);
  });
});
