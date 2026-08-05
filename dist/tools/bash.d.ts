import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare const MAX_TIMEOUT_MS = 600000;
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
export declare function bashTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<BashResult, unknown, z.core.$ZodTypeInternals<BashResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=bash.d.ts.map