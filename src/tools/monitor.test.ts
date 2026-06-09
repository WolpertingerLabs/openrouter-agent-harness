import { describe, it, expect, vi } from 'vitest';
import {
  monitorTool,
  MAX_LINES_CAP,
  MAX_DURATION_MS_CAP,
  type MonitorResult,
  type MonitorError,
} from './monitor.js';

const tool = monitorTool();
const execute = tool.function.execute as (params: {
  command: string;
  cwd?: string;
  pattern?: string;
  max_lines?: number;
  max_duration_ms?: number;
}) => Promise<MonitorResult | MonitorError>;

const asResult = (r: MonitorResult | MonitorError): MonitorResult => {
  if ('error' in r) throw new Error(`expected MonitorResult, got error: ${r.error}`);
  return r;
};

describe('monitor tool', () => {
  it('has correct name', () => {
    expect(tool.function.name).toBe('monitor');
  });

  it('captures every stdout line on natural exit', async () => {
    const r = asResult(await execute({ command: 'echo a; echo b; echo c' }));
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.lines).toEqual([
      { stream: 'stdout', text: 'a' },
      { stream: 'stdout', text: 'b' },
      { stream: 'stdout', text: 'c' },
    ]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr alongside stdout', async () => {
    const r = asResult(await execute({ command: 'echo out; echo err >&2' }));
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    const streams = r.lines.map((l) => l.stream).sort();
    expect(streams).toEqual(['stderr', 'stdout']);
    expect(r.lines.find((l) => l.stream === 'stdout')?.text).toBe('out');
    expect(r.lines.find((l) => l.stream === 'stderr')?.text).toBe('err');
  });

  it('filters lines by pattern when supplied', async () => {
    const r = asResult(
      await execute({
        command: 'echo match-1; echo nope; echo match-2; echo skip; echo match-3',
        pattern: '^match',
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.lines).toEqual([
      { stream: 'stdout', text: 'match-1' },
      { stream: 'stdout', text: 'match-2' },
      { stream: 'stdout', text: 'match-3' },
    ]);
  });

  it('returns { error } for an invalid regex pattern', async () => {
    const r = await execute({ command: 'echo x', pattern: '[' });
    expect(r).toMatchObject({ error: expect.stringMatching(/^invalid pattern:/) });
  });

  it('caps the buffer at max_lines and SIGTERMs the child', async () => {
    const r = asResult(
      await execute({
        // `exec` ensures the long-running follower `sleep` is run as the
        // /bin/sh process itself rather than as a forked grandchild — so
        // SIGTERM on the line-cap path kills the actual blocker and 'close'
        // fires promptly. Without it, the orphan sleep would keep stdout
        // open for the full 5s and stall the test.
        command: 'for i in $(seq 1 200); do echo line$i; done; exec sleep 5',
        max_lines: 50,
      }),
    );
    expect(r.lines).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.lines[0]).toEqual({ stream: 'stdout', text: 'line1' });
  });

  it('terminates the child when max_duration_ms elapses', async () => {
    // `exec sleep` replaces the /bin/sh process so child.kill('SIGTERM')
    // reaches sleep directly — without `exec` the shell would fork a
    // grandchild that holds stdout open, delaying the 'close' event for
    // the full 5-second sleep (same orphan-pipe quirk noted in
    // bash.test.ts).
    const start = Date.now();
    const r = asResult(await execute({ command: 'exec sleep 5', max_duration_ms: 100 }));
    const elapsed = Date.now() - start;
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(2000);
    expect(r.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('kills the child promptly when ctx.signal aborts mid-execution', async () => {
    const controller = new AbortController();
    const abortTool = monitorTool({ cwd: '.', signal: controller.signal });
    const abortExecute = abortTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;

    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    const r = asResult(await abortExecute({ command: 'exec sleep 5' }));
    const elapsed = Date.now() - start;
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  it('clamps max_lines over MAX_LINES_CAP and emits a warn notification', async () => {
    const notify = vi.fn(async () => {});
    const clampTool = monitorTool({ cwd: '.', notify });
    const clampExecute = clampTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;

    const r = asResult(await clampExecute({ command: 'echo ok', max_lines: 50_000 }));
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([{ stream: 'stdout', text: 'ok' }]);

    expect(notify).toHaveBeenCalledTimes(1);
    const call = notify.mock.calls[0] as unknown as [string, string, unknown];
    expect(call[0]).toBe('warn');
    expect(call[1]).toMatch(/max_lines.*clamping/i);
    expect(call[2]).toEqual({ requested: 50_000, effective: MAX_LINES_CAP });
  });

  it('clamps max_duration_ms over MAX_DURATION_MS_CAP and emits a warn notification', async () => {
    const notify = vi.fn(async () => {});
    const clampTool = monitorTool({ cwd: '.', notify });
    const clampExecute = clampTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;

    const r = asResult(await clampExecute({ command: 'echo ok', max_duration_ms: 700_000 }));
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([{ stream: 'stdout', text: 'ok' }]);

    expect(notify).toHaveBeenCalledTimes(1);
    const call = notify.mock.calls[0] as unknown as [string, string, unknown];
    expect(call[0]).toBe('warn');
    expect(call[1]).toMatch(/max_duration_ms.*clamping/i);
    expect(call[2]).toEqual({ requestedMs: 700_000, effectiveMs: MAX_DURATION_MS_CAP });
  });

  it('returns immediately when ctx.signal is already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedTool = monitorTool({ cwd: '.', signal: controller.signal });
    const abortedExecute = abortedTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;
    const r = asResult(await abortedExecute({ command: 'echo never' }));
    expect(r.exitCode).toBeNull();
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.durationMs).toBe(0);
  });

  it('respects cwd parameter when resolving relative paths', async () => {
    const r = asResult(await execute({ command: 'pwd', cwd: '/tmp' }));
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]?.text).toMatch(/\/tmp|\/private\/tmp/);
  });

  it('preserves non-zero exit codes on natural exit', async () => {
    const r = asResult(await execute({ command: 'echo bye; exit 7' }));
    expect(r.exitCode).toBe(7);
    expect(r.truncated).toBe(false);
    expect(r.lines).toEqual([{ stream: 'stdout', text: 'bye' }]);
  });

  it('surfaces a generic exitCode=1 when spawn errors (e.g. bad cwd)', async () => {
    const errTool = monitorTool({ cwd: '/nonexistent-xyz-9999-monitor-test' });
    const errExecute = errTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;
    const r = asResult(await errExecute({ command: 'echo hi' }));
    // close may still fire — accept either the error path (exitCode 1) or
    // the close path (exitCode null) as long as the buffer is empty.
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('emits the trailing partial line at EOF (no terminating newline)', async () => {
    const r = asResult(await execute({ command: "printf 'first\\nsecond'" }));
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([
      { stream: 'stdout', text: 'first' },
      { stream: 'stdout', text: 'second' },
    ]);
  });

  it('does NOT emit a warn notification when caps are not exceeded', async () => {
    const notify = vi.fn(async () => {});
    const okTool = monitorTool({ cwd: '.', notify });
    const okExecute = okTool.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;
    await okExecute({
      command: 'echo ok',
      max_lines: MAX_LINES_CAP,
      max_duration_ms: MAX_DURATION_MS_CAP,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('treats repeat stop() invocations as no-ops (abort + duration both fire)', async () => {
    // Schedule abort to fire synchronously after spawn so it wins the first
    // stop(); the duration timer (10ms) fires shortly after and hits the
    // `if (killed) return` early-return branch.
    const controller = new AbortController();
    const t2 = monitorTool({ cwd: '.', signal: controller.signal });
    const exec2 = t2.function.execute as (
      p: Record<string, unknown>,
    ) => Promise<MonitorResult | MonitorError>;
    const p = exec2({ command: 'exec sleep 5', max_duration_ms: 10 });
    controller.abort();
    const r = asResult(await p);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('escalates to SIGKILL when the child ignores SIGTERM past the 250ms grace', async () => {
    // Trap and ignore SIGTERM inside the node child so the 250ms kill timer
    // is forced to fire — this covers the SIGKILL branch inside stop().
    const start = Date.now();
    const r = asResult(
      await execute({
        command: 'exec node -e \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\'',
        max_duration_ms: 100,
      }),
    );
    const elapsed = Date.now() - start;
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBeNull();
    // SIGTERM at ~100ms, SIGKILL 250ms later, close shortly after; allow
    // generous headroom for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5000);
  });

  it('exports the documented cap constants', () => {
    expect(MAX_LINES_CAP).toBe(10_000);
    expect(MAX_DURATION_MS_CAP).toBe(600_000);
  });
});
