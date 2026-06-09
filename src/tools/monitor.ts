import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';

const DEFAULT_MAX_LINES = 1000;
export const MAX_LINES_CAP = 10_000;
const DEFAULT_MAX_DURATION_MS = 60_000;
export const MAX_DURATION_MS_CAP = 600_000;
const KILL_GRACE_MS = 250;

export interface MonitorLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface MonitorResult {
  exitCode: number | null;
  lines: MonitorLine[];
  truncated: boolean;
  durationMs: number;
}

export interface MonitorError {
  error: string;
}

export function monitorTool(ctx: ToolContext = DEFAULT_TOOL_CONTEXT) {
  return tool({
    name: 'monitor',
    description:
      'Spawn a background shell command and capture its stdout/stderr line-by-line. Resolves when the process exits, the line buffer fills (default 1000, max 10000), max_duration_ms elapses (default 60s, max 10min), or the run is aborted. Use for tailing dev-server output, polling external state, or watching a build-watcher for a specific log line.',
    inputSchema: z.object({
      command: z.string().describe('Shell command to execute via /bin/sh -c.'),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory for the command. Resolved against the run's cwd if relative. Omit to inherit the run's cwd.",
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          'Optional JS regex (string) — when set, only lines matching the pattern are captured. Tested against each stdout/stderr line individually. Invalid regex resolves with { error: "invalid pattern: ..." }.',
        ),
      max_lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Maximum number of lines to capture before SIGTERMing the child. Default ${DEFAULT_MAX_LINES}; silently clamped to ${MAX_LINES_CAP} with a warn notification. Hitting this limit marks the result truncated.`,
        ),
      max_duration_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Maximum wall-clock duration in milliseconds. Default ${DEFAULT_MAX_DURATION_MS}; silently clamped to ${MAX_DURATION_MS_CAP} with a warn notification. Elapsing this timer SIGTERMs the child and marks the result truncated.`,
        ),
    }),
    execute: async ({
      command,
      cwd: argCwd,
      pattern,
      max_lines,
      max_duration_ms,
    }): Promise<MonitorResult | MonitorError> => {
      let regex: RegExp | undefined;
      if (pattern !== undefined) {
        try {
          regex = new RegExp(pattern);
        } catch (err) {
          return { error: `invalid pattern: ${(err as Error).message}` };
        }
      }

      let effectiveMaxLines = max_lines ?? DEFAULT_MAX_LINES;
      if (effectiveMaxLines > MAX_LINES_CAP) {
        const requested = effectiveMaxLines;
        effectiveMaxLines = MAX_LINES_CAP;
        await ctx.notify?.('warn', 'monitor max_lines exceeds cap, clamping', {
          requested,
          effective: effectiveMaxLines,
        });
      }

      let effectiveMaxDurationMs = max_duration_ms ?? DEFAULT_MAX_DURATION_MS;
      if (effectiveMaxDurationMs > MAX_DURATION_MS_CAP) {
        const requestedMs = effectiveMaxDurationMs;
        effectiveMaxDurationMs = MAX_DURATION_MS_CAP;
        await ctx.notify?.('warn', 'monitor max_duration_ms exceeds cap, clamping', {
          requestedMs,
          effectiveMs: effectiveMaxDurationMs,
        });
      }

      const startTime = Date.now();

      if (ctx.signal?.aborted) {
        return { exitCode: null, lines: [], truncated: true, durationMs: 0 };
      }

      const effectiveCwd = argCwd ? resolve(ctx.cwd, argCwd) : ctx.cwd;

      return new Promise<MonitorResult>((resolveResult) => {
        const child = spawn('/bin/sh', ['-c', command], { cwd: effectiveCwd });

        const lines: MonitorLine[] = [];
        let truncated = false;
        let killed = false;
        let finished = false;
        let killTimer: NodeJS.Timeout | undefined;

        // SIGTERM + 250ms SIGKILL grace, mirroring src/tools/bash.ts.
        const stop = (): void => {
          if (killed) return;
          killed = true;
          truncated = true;
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

        const handleLine = (stream: 'stdout' | 'stderr', text: string): void => {
          if (killed) return;
          if (regex && !regex.test(text)) return;
          lines.push({ stream, text });
          if (lines.length >= effectiveMaxLines) {
            stop();
          }
        };

        const durationTimer = setTimeout(() => stop(), effectiveMaxDurationMs);

        const onAbort = (): void => stop();
        if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

        // Default stdio is 'pipe' so child.stdout / child.stderr are always
        // Readable streams — the `!` is type-narrowing, not a runtime risk.
        const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        stdoutRl.on('line', (text) => handleLine('stdout', text));
        const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
        stderrRl.on('line', (text) => handleLine('stderr', text));

        const finish = (result: MonitorResult): void => {
          if (finished) return;
          finished = true;
          clearTimeout(durationTimer);
          if (killTimer) clearTimeout(killTimer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
          resolveResult(result);
        };

        child.on('error', () => {
          finish({
            exitCode: 1,
            lines,
            truncated,
            durationMs: Date.now() - startTime,
          });
        });

        child.on('close', (code) => {
          finish({
            exitCode: killed ? null : code,
            lines,
            truncated,
            durationMs: Date.now() - startTime,
          });
        });
      });
    },
  });
}
