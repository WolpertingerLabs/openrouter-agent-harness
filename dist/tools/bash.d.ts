import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare const MAX_TIMEOUT_MS = 600000;
export interface BashResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export declare function bashTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<BashResult, unknown, z.core.$ZodTypeInternals<BashResult, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=bash.d.ts.map