import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare const MAX_LINES_CAP = 10000;
export declare const MAX_DURATION_MS_CAP = 600000;
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
export declare function monitorTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    pattern: z.ZodOptional<z.ZodString>;
    max_lines: z.ZodOptional<z.ZodNumber>;
    max_duration_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<MonitorResult | MonitorError, unknown, z.core.$ZodTypeInternals<MonitorResult | MonitorError, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=monitor.d.ts.map