/**
 * Schema version for every {@link TranscriptRecord} written. Bumped only when a
 * backward-incompatible field change ships; readers should ignore lines whose
 * `v` they don't understand.
 */
export declare const TRANSCRIPT_SCHEMA_VERSION = 1;
export interface TranscriptUsage {
    prompt: number;
    completion: number;
    reasoning?: number;
    cached?: number;
}
export interface TranscriptToolCall {
    callId: string;
    name: string;
    input: unknown;
}
export type TranscriptRecord = {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'session_start';
    cwd: string;
    parentSessionId?: string;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'user';
    text: string;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'assistant';
    turnNumber: number;
    requestId: string;
    model: string;
    text?: string;
    reasoning?: string;
    toolCalls?: TranscriptToolCall[];
    usage?: TranscriptUsage;
    costUsd?: number;
    durationMs?: number;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'tool_result';
    callId: string;
    name: string;
    isError: boolean;
    output: unknown;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'server_tool';
    /** Full output-item discriminator, e.g. `"openrouter:web_search"`. */
    toolType: string;
    /** The item's `id` when the provider supplied one. */
    callId?: string;
    /** SDK `ToolCallStatus`: `"completed"` / `"in_progress"` / `"incomplete"`. */
    status: string;
    /** Best-effort model input (e.g. web_search `{ query }`); often absent. */
    input?: unknown;
    /** Result payload with the envelope keys (`type`/`id`/`status`) stripped. */
    output: unknown;
    /** Derived failure flag (web_fetch `error`, or non-`completed` status). */
    isError: boolean;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'compact';
    reason: 'auto' | 'manual';
    droppedMessages: number;
    summaryText: string;
    usage?: TranscriptUsage;
    costUsd?: number;
} | {
    v: typeof TRANSCRIPT_SCHEMA_VERSION;
    sessionId: string;
    ts: string;
    kind: 'session_end';
    status: 'success' | 'max_turns' | 'max_budget' | 'error';
    reason?: string;
    totalUsage?: TranscriptUsage;
    totalCostUsd?: number;
};
export type TranscriptRecordKind = TranscriptRecord['kind'];
interface CommonInput {
    logsRoot: string;
    sessionId: string;
    ts?: string;
}
export declare function logTranscriptSessionStart(input: CommonInput & {
    cwd: string;
    parentSessionId?: string;
}): Promise<void>;
export declare function logTranscriptUser(input: CommonInput & {
    text: string;
}): Promise<void>;
export declare function logTranscriptAssistant(input: CommonInput & {
    turnNumber: number;
    requestId: string;
    model: string;
    text?: string;
    reasoning?: string;
    toolCalls?: TranscriptToolCall[];
    usage?: TranscriptUsage;
    costUsd?: number;
    durationMs?: number;
}): Promise<void>;
export declare function logTranscriptToolResult(input: CommonInput & {
    callId: string;
    name: string;
    isError: boolean;
    output: unknown;
}): Promise<void>;
export declare function logTranscriptServerTool(input: CommonInput & {
    toolType: string;
    callId?: string;
    status: string;
    input?: unknown;
    output: unknown;
    isError: boolean;
}): Promise<void>;
export declare function logTranscriptCompact(input: CommonInput & {
    reason: 'auto' | 'manual';
    droppedMessages: number;
    summaryText: string;
    usage?: TranscriptUsage;
    costUsd?: number;
}): Promise<void>;
export declare function logTranscriptSessionEnd(input: CommonInput & {
    status: 'success' | 'max_turns' | 'max_budget' | 'error';
    reason?: string;
    totalUsage?: TranscriptUsage;
    totalCostUsd?: number;
}): Promise<void>;
/**
 * Stream every record from a session's transcript in append order. Missing
 * file → empty iterable (mirrors the ENOENT-tolerant shape of
 * `createFileStateAccessor.load`). Malformed lines are skipped silently —
 * older readers shouldn't crash on schema-evolution garbage.
 */
export declare function readTranscript(logsRoot: string, sessionId: string): AsyncIterable<TranscriptRecord>;
export {};
//# sourceMappingURL=transcript.d.ts.map