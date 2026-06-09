import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

const TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 250;
const MAX_BUFFER = 1024 * 1024;

/**
 * Structured result from a bash invocation. The contract:
 *
 *   - `isError` is set to `true` whenever the command failed in any way: a
 *     non-zero exit, a kill signal (SIGTERM/SIGKILL), an abort
 *     (`cancelled: true`), a timeout (`timedOut: true`), or a pre-spawn
 *     cancellation. It is omitted (undefined) on success. The agent's
 *     `detectToolResultIsError` in `agent.ts` reads this field off the
 *     serialized JSON output and lifts it into the `tool_result.isError`
 *     stream event — so failed bash commands reach the model with
 *     `isError: true` even though the tool resolves (rather than throws).
 *   - `killSignal` is `'SIGTERM'` or `'SIGKILL'` when the child exited via
 *     signal. Models that want to distinguish "tests failed" from "command
 *     was killed" should branch on this field, not on stderr substring
 *     matching.
 *   - `cancelled: true` indicates the run-level AbortSignal fired (either
 *     before spawn, in which case `killSignal` is absent, or mid-execution,
 *     in which case the cancel-triggered SIGTERM also populates
 *     `killSignal`).
 *   - `timedOut: true` indicates `timeout_ms` elapsed.
 *   - `stdoutTruncated` / `stderrTruncated` flag a buffer overflow past
 *     `MAX_BUFFER` (1 MB per stream). The captured prefix is still returned;
 *     further bytes are silently dropped.
 */
export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  isError?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  killSignal?: 'SIGTERM' | 'SIGKILL';
  cancelled?: boolean;
  timedOut?: boolean;
}

export function bashTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'bash',
    description:
      'Execute a shell command and return stdout/stderr. Use for running tests, builds, git commands, etc. Commands time out after 30 seconds by default; pass timeout_ms (clamped at 10 minutes) to override. The result includes structured failure fields: `isError: true` on any non-zero exit, signal kill, abort, or timeout; `killSignal`, `cancelled`, `timedOut`, and `stdoutTruncated`/`stderrTruncated` flags distinguish the failure mode without stderr substring matching.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z
        .string()
        .describe(
          "Working directory for the command. Resolved against the run's cwd if relative. Omit to inherit the run's cwd.",
        )
        .optional(),
      description: z
        .string()
        .describe(
          'Optional, advisory free-text note from the model explaining the intent behind this call. Purely informational — not interpreted by the tool, not echoed to stdout/stderr.',
        )
        .optional(),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .describe(
          'Optional override for the timeout in milliseconds. Default 30000. Clamped to a maximum of 600000 (10 minutes); a warn notification is emitted when clamping fires.',
        )
        .optional(),
    }),
    execute: async ({ command, cwd: argCwd, timeout_ms }): Promise<BashResult> => {
      if (ctx.signal?.aborted) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'bash cancelled before start',
          cancelled: true,
          isError: true,
        };
      }

      let effectiveTimeoutMs = timeout_ms ?? TIMEOUT_MS;
      if (effectiveTimeoutMs > MAX_TIMEOUT_MS) {
        const requestedMs = effectiveTimeoutMs;
        effectiveTimeoutMs = MAX_TIMEOUT_MS;
        await ctx.notify?.('warn', 'bash timeout_ms exceeds MAX_TIMEOUT_MS, clamping', {
          requestedMs,
          effectiveMs: effectiveTimeoutMs,
        });
      }

      const effectiveCwd = argCwd ? resolve(ctx.cwd, argCwd) : ctx.cwd;

      return new Promise<BashResult>((resolveResult) => {
        const child = spawn('sh', ['-c', command], { cwd: effectiveCwd });

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let cancelled = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
        }, effectiveTimeoutMs);

        const onAbort = () => {
          cancelled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, KILL_GRACE_MS);
        };
        if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutBytes >= MAX_BUFFER) {
            stdoutTruncated = true;
            return;
          }
          const text = chunk.toString();
          stdoutBytes += chunk.byteLength;
          stdout += text;
          if (stdoutBytes >= MAX_BUFFER) stdoutTruncated = true;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_BUFFER) {
            stderrTruncated = true;
            return;
          }
          const text = chunk.toString();
          stderrBytes += chunk.byteLength;
          stderr += text;
          if (stderrBytes >= MAX_BUFFER) stderrTruncated = true;
        });

        const finalize = (base: BashResult): void => {
          clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
          if (stdoutTruncated) base.stdoutTruncated = true;
          if (stderrTruncated) base.stderrTruncated = true;
          const failed =
            base.exitCode !== 0 ||
            base.cancelled === true ||
            base.timedOut === true ||
            base.killSignal !== undefined;
          if (failed) base.isError = true;
          resolveResult(base);
        };

        child.on('error', (err) => {
          finalize({ exitCode: 1, stdout, stderr: err.message });
        });

        child.on('close', (code, killSignal) => {
          const base: BashResult = { exitCode: code ?? 1, stdout, stderr };
          if (cancelled) base.cancelled = true;
          if (timedOut) base.timedOut = true;
          if (killSignal === 'SIGTERM' || killSignal === 'SIGKILL') {
            base.killSignal = killSignal;
          }
          finalize(base);
        });
      });
    },
  });
}
