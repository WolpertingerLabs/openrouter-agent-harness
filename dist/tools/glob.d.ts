import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export interface GlobResult {
    pattern: string;
    path: string;
    matches: string[];
    matchCount: number;
    truncated: boolean;
}
export declare function globTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodDefault<z.ZodString>;
    case_sensitive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, z.core.$ZodType<GlobResult, unknown, z.core.$ZodTypeInternals<GlobResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=glob.d.ts.map