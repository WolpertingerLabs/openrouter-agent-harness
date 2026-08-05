import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare function readFileTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodString;
    start_line: z.ZodOptional<z.ZodNumber>;
    end_line: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<{
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    truncated: boolean;
    notice: string;
} | {
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    truncated?: undefined;
    notice?: undefined;
} | {
    content: string;
    path: string;
    start_line?: undefined;
    end_line?: undefined;
    total_lines?: undefined;
    truncated?: undefined;
    notice?: undefined;
}, unknown, z.core.$ZodTypeInternals<{
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    truncated: boolean;
    notice: string;
} | {
    content: string;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    truncated?: undefined;
    notice?: undefined;
} | {
    content: string;
    path: string;
    start_line?: undefined;
    end_line?: undefined;
    total_lines?: undefined;
    truncated?: undefined;
    notice?: undefined;
}, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=read-file.d.ts.map