import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare function writeFileTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    checkpoint: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.core.$ZodType<{
    path: string;
    bytesWritten: number;
}, unknown, z.core.$ZodTypeInternals<{
    path: string;
    bytesWritten: number;
}, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=write-file.d.ts.map