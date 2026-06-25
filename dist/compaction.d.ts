/**
 * Phase 5.1: context-compaction primitives. Pure functions — no SDK / FS
 * coupling, so they can be unit-tested in isolation from
 * {@link OpenRouterAgentRun}. The wiring into the run loop lives in
 * `src/agent.ts`.
 */
/**
 * System prompt sent to the summarizer model during compaction. v1 is a fixed
 * string constant (not configurable) — exported here so tests and external
 * code can reason about the exact instructions the summarizer receives. The
 * partition prefix is sent verbatim as the model's `input`; this prompt is
 * passed via the `instructions` field.
 */
export declare const COMPACTION_PROMPT = "You are a context-compaction assistant. The user message is the JSON-encoded prefix of an ongoing conversation between a user and an AI coding agent (including tool calls and tool outputs) that has grown too long to keep in full. Summarize this prefix into a concise narrative that preserves: (1) the user goals and constraints, (2) decisions made and their rationale, (3) files, paths, and identifiers referenced, (4) any unresolved tasks. Omit verbose tool outputs that no longer matter. Return only the summary text \u2014 do not preface it with commentary, do not wrap it in markdown, do not include a heading.";
/**
 * Approximate average character → token ratio used by the v1 char-length
 * heuristic. The ~4-chars-per-token figure is the conservative end of the
 * range used by OpenAI / Anthropic tokenizers for English text; non-English
 * prose, code, or JSON-encoded tool calls tend to fall in the 3.5–4.5 band.
 * v1 ships without a real tokenizer dep ({@link getModelContextWindow}
 * already biases the threshold via {@link DEFAULT_THRESHOLD_RATIO}).
 */
export declare const CHARS_PER_TOKEN = 4;
/**
 * Fraction of the model's context window that triggers an auto-compaction
 * when no explicit `compactionThreshold` is supplied to the run. 0.8 leaves
 * ~20% headroom for the next turn's input + response.
 */
export declare const DEFAULT_THRESHOLD_RATIO = 0.8;
/**
 * Phase 7.1: default output reserve (in **tokens**) subtracted from the
 * context window when the absolute-buffer threshold shape is requested (see
 * {@link resolveCompactionThresholdTokens}'s `reserveOpts`). ~20k matches the
 * shape adopted by Claude Code and opencode: this is the room the model needs
 * to *respond* — and, critically, the room the summarizer call itself needs
 * to emit its summary without overflowing. A bare ratio does not guarantee
 * that on large windows.
 */
export declare const DEFAULT_OUTPUT_RESERVE_TOKENS = 20000;
/**
 * Phase 7.1: default extra safety buffer (in **tokens**) added on top of the
 * output reserve under the absolute-buffer threshold shape. Covers
 * measurement slop — uncounted tool-schema growth between the threshold check
 * and the next request, plus the gap between the server's `inputTokens`
 * accounting and our estimate on the first turn. Claude Code carries a ~13k
 * margin on a 200k window; we adopt a smaller flat 8k so narrow windows are
 * not over-reserved into uselessness.
 */
export declare const DEFAULT_SAFETY_BUFFER_TOKENS = 8000;
/**
 * Conservative fallback context-window size (in tokens) used when the active
 * model is not present in {@link MODEL_CONTEXT_WINDOWS}. 128k matches the
 * smaller end of the modern frontier-model band and avoids overestimating
 * for unknown deployments.
 */
export declare const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
/**
 * Hard-coded table of well-known OpenRouter / Anthropic / OpenAI / Google
 * model context-window sizes (in tokens). Lookups are exact-match first, then
 * with the `~` alias prefix stripped (e.g. `~anthropic/claude-sonnet-latest`
 * → `anthropic/claude-sonnet-latest`). v1 deliberately ships a static table
 * rather than fetching `/api/v1/models` so that compaction has no network
 * dependency. Add new entries here as they ship.
 */
export declare const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>>;
/**
 * Resolve the context-window size (in tokens) for a given model id. Lookup
 * order: caller-supplied `overrides` exact match → `overrides` with a
 * leading `~` (OR alias marker) stripped → static
 * {@link MODEL_CONTEXT_WINDOWS} exact match → static table alias → the
 * {@link DEFAULT_CONTEXT_WINDOW_TOKENS} fallback. Overrides let a host
 * teach the harness about models the shipped table doesn't know (or correct
 * stale entries) per run — see
 * {@link import('./agent.js').OpenRouterAgentRunOptions.modelContextWindows}.
 *
 * Exported so consumers can pre-compute a sensible `compactionThreshold` for
 * a model whose default they want to override, without re-deriving the table.
 */
export declare function getModelContextWindow(model: string, overrides?: Readonly<Record<string, number>>): number;
/**
 * Resolve the threshold (in **characters**, not tokens) that triggers
 * auto-compaction under the default chars/4 heuristic. Caller-supplied
 * `configured` wins outright — it is interpreted as a raw character count so
 * consumers can opt out of the char-per-token translation entirely. When
 * omitted, the threshold is `getModelContextWindow(model, overrides) *
 * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO`.
 */
export declare function resolveCompactionThresholdChars(configured: number | undefined, model: string, overrides?: Readonly<Record<string, number>>): number;
/**
 * Resolve the threshold (in **tokens**) that triggers auto-compaction when a
 * real `tokenCounter` is wired (see
 * {@link import('./agent.js').OpenRouterAgentRunOptions.tokenCounter}).
 * Caller-supplied `configured` wins outright — under token accounting the
 * run's `compactionThreshold` is REINTERPRETED as a token count (the
 * char-count reading only applies to the heuristic path). When omitted, the
 * threshold is `floor(getModelContextWindow(model, overrides) *
 * DEFAULT_THRESHOLD_RATIO)` — no chars-per-token translation, because the
 * comparison side is already a real token count.
 *
 * Phase 7.1: when `reserveOpts` is supplied AND no explicit `configured`
 * threshold is set, the **absolute-buffer** shape is used instead of the bare
 * ratio: `window − outputReserve − safetyBuffer` (Claude Code / opencode).
 * The reserve guarantees the summarizer call itself has room to respond — a
 * ratio alone does not on large windows. The result is floored at 25% of the
 * window so a pathologically small / mis-resolved window never yields a
 * non-positive (always-trigger) threshold; pass an explicit threshold to
 * force-trigger every turn instead. When `reserveOpts` is omitted the prior
 * ratio behavior is preserved exactly (back-compat with the merged callers).
 */
export declare function resolveCompactionThresholdTokens(configured: number | undefined, model: string, overrides?: Readonly<Record<string, number>>, reserveOpts?: {
    outputReserveTokens?: number;
    safetyBufferTokens?: number;
}): number;
/**
 * Phase 7.1: cold-start input-token estimate for the first turn of a fresh
 * session, when no real `usage.inputTokens` sample exists yet. The message
 * heuristic misses the two large prefix components a cron-style session sends
 * on every request — the `instructions` block and the serialized tool
 * schemas — both of which can dominate the window before a single message is
 * counted. Returns a **token** estimate (chars / {@link CHARS_PER_TOKEN}).
 *
 * `tools` is serialized defensively per-item; unserializable entries (cyclic
 * test fixtures) contribute nothing, matching
 * {@link serializeMessagesForEstimate}.
 */
export declare function estimateInstructionsAndToolsTokens(opts: {
    instructions?: string;
    tools?: readonly unknown[];
}): number;
/**
 * Canonical serialization of the SDK's `ConversationState.messages` field
 * (`InputsUnion`) for size estimation. The raw string form passes through
 * verbatim; the array form concatenates each item's `JSON.stringify` (cheap
 * enough at compaction scale — runs once per run boundary at most);
 * non-message inputs (`null`, `undefined`, anything else) serialize to `''`.
 *
 * Shared by BOTH accounting paths so they measure exactly the same bytes:
 * {@link estimateMessagesCharLength} takes this string's length (the chars/4
 * heuristic), and the agent's `tokenCounter` hook receives this string
 * verbatim for real token counting.
 */
export declare function serializeMessagesForEstimate(messages: unknown): string;
/**
 * Char-length heuristic for the SDK's `ConversationState.messages` field —
 * the length of {@link serializeMessagesForEstimate}'s output. Kept as a
 * named export (rather than inlining `.length` at call sites) for back-compat
 * and so the heuristic reads symmetrically with the tokenizer path.
 */
export declare function estimateMessagesCharLength(messages: unknown): number;
/**
 * Split a message array into a `summarize` prefix and a `keep` tail. The tail
 * length is `min(messages.length, keepRecentTurns)`. When the array is
 * shorter than the keep window, the prefix is empty and no compaction is
 * needed.
 *
 * Note: `keepRecentTurns` is interpreted at **message** granularity, not
 * strict conversational-turn granularity. The SDK's `InputsUnion` mixes user
 * messages, assistant output items, reasoning items, tool calls, and tool
 * results — a robust turn-boundary detector is deferred to a future card
 * (the v1 heuristic keeps the implementation predictable and dependency-free).
 */
export declare function partitionMessages<T>(messages: readonly T[], keepRecentTurns: number): {
    summarize: readonly T[];
    keep: readonly T[];
};
/** Default number of trailing messages preserved verbatim during compaction. */
export declare const DEFAULT_KEEP_RECENT_TURNS = 5;
//# sourceMappingURL=compaction.d.ts.map