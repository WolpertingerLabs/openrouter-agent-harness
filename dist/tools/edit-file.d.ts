import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare function editFileTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodString;
    old_string: z.ZodString;
    new_string: z.ZodString;
    replace_all: z.ZodOptional<z.ZodBoolean>;
    checkpoint: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.core.$ZodType<{
    path: string;
    replaced: boolean;
    replacedCount: number;
}, unknown, z.core.$ZodTypeInternals<{
    path: string;
    replaced: boolean;
    replacedCount: number;
}, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=edit-file.d.ts.map