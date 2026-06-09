import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

const TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 250;

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function bashTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'bash',
    description:
      'Execute a shell command and return stdout/stderr. Use for running tests, builds, git commands, etc. Commands time out after 30 seconds by default; pass timeout_ms (clamped at 10 minutes) to override.',
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
        return { exitCode: 1, stdout: '', stderr: 'bash cancelled before start' };
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
        const MAX_BUFFER = 1024 * 1024;
        let cancelled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const timeoutTimer = setTimeout(() => {
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
          if (stdoutBytes >= MAX_BUFFER) return;
          const text = chunk.toString();
          stdoutBytes += chunk.byteLength;
          stdout += text;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_BUFFER) return;
          const text = chunk.toString();
          stderrBytes += chunk.byteLength;
          stderr += text;
        });

        const finish = (result: BashResult): void => {
          clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
          resolveResult(result);
        };

        child.on('error', (err) => {
          finish({ exitCode: 1, stdout, stderr: err.message });
        });

        child.on('close', (code, killSignal) => {
          if (cancelled) {
            const suffix = stderr && !stderr.endsWith('\n') ? '\n' : '';
            finish({
              exitCode: code ?? 1,
              stdout,
              stderr: stderr + suffix + 'bash cancelled',
            });
            return;
          }
          if (killSignal === 'SIGTERM' || killSignal === 'SIGKILL') {
            const suffix = stderr && !stderr.endsWith('\n') ? '\n' : '';
            finish({
              exitCode: code ?? 1,
              stdout,
              stderr: stderr + suffix + `terminated by ${killSignal}`,
            });
            return;
          }
          finish({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    },
  });
}
