import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export interface GrepMatch {
    file: string;
    line: number;
    text: string;
    /** Lines immediately preceding `text` (oldest first). Empty unless `before_context > 0`. */
    before?: string[];
    /** Lines immediately following `text` (in source order). Empty unless `after_context > 0`. */
    after?: string[];
}
export declare function grepFilesTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodDefault<z.ZodString>;
    file_glob: z.ZodDefault<z.ZodString>;
    case_sensitive: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodOptional<z.ZodString>;
    before_context: z.ZodOptional<z.ZodNumber>;
    after_context: z.ZodOptional<z.ZodNumber>;
    context: z.ZodOptional<z.ZodNumber>;
    output_mode: z.ZodDefault<z.ZodEnum<{
        content: "content";
        files_with_matches: "files_with_matches";
        count: "count";
    }>>;
}, z.core.$strip>, z.core.$ZodType<{
    pattern: string;
    path: string;
    mode: "files_with_matches";
    files: string[];
    matchCount: number;
    truncated: boolean;
    totalMatches?: undefined;
    perFile?: undefined;
    matches?: undefined;
} | {
    pattern: string;
    path: string;
    mode: "count";
    totalMatches: number;
    perFile: {
        file: string;
        count: number;
    }[];
    truncated: boolean;
    files?: undefined;
    matchCount?: undefined;
    matches?: undefined;
} | {
    pattern: string;
    path: string;
    matchCount: number;
    truncated: boolean;
    matches: GrepMatch[];
    mode?: undefined;
    files?: undefined;
    totalMatches?: undefined;
    perFile?: undefined;
}, unknown, z.core.$ZodTypeInternals<{
    pattern: string;
    path: string;
    mode: "files_with_matches";
    files: string[];
    matchCount: number;
    truncated: boolean;
    totalMatches?: undefined;
    perFile?: undefined;
    matches?: undefined;
} | {
    pattern: string;
    path: string;
    mode: "count";
    totalMatches: number;
    perFile: {
        file: string;
        count: number;
    }[];
    truncated: boolean;
    files?: undefined;
    matchCount?: undefined;
    matches?: undefined;
} | {
    pattern: string;
    path: string;
    matchCount: number;
    truncated: boolean;
    matches: GrepMatch[];
    mode?: undefined;
    files?: undefined;
    totalMatches?: undefined;
    perFile?: undefined;
}, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=grep-files.d.ts.map