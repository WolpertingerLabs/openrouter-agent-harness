import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export interface EditNotebookSuccess {
    ok: true;
    cells: number;
}
export interface EditNotebookError {
    error: string;
}
export type EditNotebookResult = EditNotebookSuccess | EditNotebookError;
export declare function editNotebookTool(ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    path: z.ZodString;
    operation: z.ZodEnum<{
        replace_source: "replace_source";
        insert: "insert";
        delete: "delete";
        change_type: "change_type";
    }>;
    cell_index: z.ZodNumber;
    new_source: z.ZodOptional<z.ZodString>;
    new_cell_type: z.ZodOptional<z.ZodEnum<{
        code: "code";
        markdown: "markdown";
    }>>;
}, z.core.$strip>, z.core.$ZodType<EditNotebookResult, unknown, z.core.$ZodTypeInternals<EditNotebookResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=edit-notebook.d.ts.map