import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
export declare const MAX_TIMEOUT_MS = 600000;
/**
 * Question payload handed to the host's `onAskUserQuestion` callback. The
 * library generates `questionId` (UUID) and per-option `id` (lexicographic
 * `a`..`z`) at tool-execute time so the host can correlate the response.
 */
export interface UserQuestionRequest {
    questionId: string;
    question: string;
    options: Array<{
        id: string;
        label: string;
        preview?: string;
    }>;
    allowFreeText?: boolean;
}
/**
 * Host's reply to a {@link UserQuestionRequest}. At least one of
 * `selectedOptionId` / `freeTextAnswer` should be populated.
 * `questionId` MUST echo the request's id so the library can sanity-check.
 */
export interface UserQuestionResponse {
    questionId: string;
    selectedOptionId?: string;
    freeTextAnswer?: string;
}
export type OnAskUserQuestion = (req: UserQuestionRequest) => Promise<UserQuestionResponse>;
export interface AskUserQuestionToolOptions {
    /** Host callback that renders the question and resolves with the user's choice. */
    onAskUserQuestion?: OnAskUserQuestion;
}
export interface AskUserQuestionToolResult {
    selectedOptionId?: string;
    label?: string;
    freeTextAnswer?: string;
    error?: string;
}
export declare function askUserQuestionTool(ctx?: ToolContext, opts?: AskUserQuestionToolOptions): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    question: z.ZodString;
    options: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        preview: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    allow_free_text: z.ZodOptional<z.ZodBoolean>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<AskUserQuestionToolResult, unknown, z.core.$ZodTypeInternals<AskUserQuestionToolResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=ask-user-question.d.ts.map