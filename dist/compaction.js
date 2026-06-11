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
export const COMPACTION_PROMPT = 'You are a context-compaction assistant. The user message is a role-labelled transcript of the prefix of an ongoing conversation between a user and an AI coding agent (including tool calls and truncated tool outputs) that has grown too long to keep in full. Summarize this prefix into a concise narrative that preserves: (1) the user goals and constraints, (2) decisions made and their rationale, (3) files, paths, and identifiers referenced, (4) any unresolved tasks. Omit verbose tool outputs that no longer matter. Return only the summary text — do not preface it with commentary, do not wrap it in markdown, do not include a heading.';
/**
 * Approximate average character → token ratio used by the v1 char-length
 * heuristic. The ~4-chars-per-token figure is the conservative end of the
 * range used by OpenAI / Anthropic tokenizers for English text; non-English
 * prose, code, or JSON-encoded tool calls tend to fall in the 3.5–4.5 band.
 * v1 ships without a real tokenizer dep ({@link getModelContextWindow}
 * already biases the threshold via {@link DEFAULT_THRESHOLD_RATIO}).
 */
export const CHARS_PER_TOKEN = 4;
/**
 * Fraction of the model's context window that triggers an auto-compaction
 * when no explicit `compactionThreshold` is supplied to the run. 0.8 leaves
 * ~20% headroom for the next turn's input + response.
 */
export const DEFAULT_THRESHOLD_RATIO = 0.8;
/**
 * Phase 7.1: default output reserve (in **tokens**) subtracted from the
 * context window when the absolute-buffer threshold shape is requested (see
 * {@link resolveCompactionThresholdTokens}'s `reserveOpts`). ~20k matches the
 * shape adopted by Claude Code and opencode: this is the room the model needs
 * to *respond* — and, critically, the room the summarizer call itself needs
 * to emit its summary without overflowing. A bare ratio does not guarantee
 * that on large windows.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 20_000;
/**
 * Phase 7.1: default extra safety buffer (in **tokens**) added on top of the
 * output reserve under the absolute-buffer threshold shape. Covers
 * measurement slop — uncounted tool-schema growth between the threshold check
 * and the next request, plus the gap between the server's `inputTokens`
 * accounting and our estimate on the first turn. Claude Code carries a ~13k
 * margin on a 200k window; we adopt a smaller flat 8k so narrow windows are
 * not over-reserved into uselessness.
 */
export const DEFAULT_SAFETY_BUFFER_TOKENS = 8_000;
/**
 * Conservative fallback context-window size (in tokens) used when the active
 * model is not present in {@link MODEL_CONTEXT_WINDOWS}. 128k matches the
 * smaller end of the modern frontier-model band and avoids overestimating
 * for unknown deployments.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/**
 * Hard-coded table of well-known OpenRouter / Anthropic / OpenAI / Google
 * model context-window sizes (in tokens). Lookups are exact-match first, then
 * with the `~` alias prefix stripped (e.g. `~anthropic/claude-sonnet-latest`
 * → `anthropic/claude-sonnet-latest`). v1 deliberately ships a static table
 * rather than fetching `/api/v1/models` so that compaction has no network
 * dependency. Add new entries here as they ship.
 */
export const MODEL_CONTEXT_WINDOWS = Object.freeze({
    // Anthropic Claude — 200k standard, 1M for the "[1m]" variants
    'anthropic/claude-sonnet-latest': 200_000,
    'anthropic/claude-opus-latest': 200_000,
    'anthropic/claude-haiku-latest': 200_000,
    'anthropic/claude-sonnet-4.6': 200_000,
    'anthropic/claude-opus-4.7': 200_000,
    'anthropic/claude-opus-4-7': 200_000,
    'anthropic/claude-haiku-4.5': 200_000,
    'anthropic/claude-3-5-sonnet': 200_000,
    'anthropic/claude-3-5-haiku': 200_000,
    // OpenAI
    'openai/gpt-5': 400_000,
    'openai/gpt-5.1': 400_000,
    'openai/gpt-4.1': 1_000_000,
    'openai/gpt-4o': 128_000,
    'openai/gpt-4o-mini': 128_000,
    'openai/o1': 200_000,
    'openai/o3': 200_000,
    // Google Gemini
    'google/gemini-2.5-pro': 1_000_000,
    'google/gemini-2.5-flash': 1_000_000,
    'google/gemini-2.0-flash': 1_000_000,
    // xAI Grok
    'xai/grok-4': 256_000,
    'xai/grok-3': 131_072,
    // Qwen
    'qwen/qwen3-coder': 256_000,
});
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
export function getModelContextWindow(model, overrides) {
    const stripped = model.startsWith('~') ? model.slice(1) : undefined;
    if (overrides !== undefined) {
        const overrideExact = overrides[model];
        if (overrideExact !== undefined)
            return overrideExact;
        if (stripped !== undefined) {
            const overrideAliased = overrides[stripped];
            if (overrideAliased !== undefined)
                return overrideAliased;
        }
    }
    const exact = MODEL_CONTEXT_WINDOWS[model];
    if (exact !== undefined)
        return exact;
    if (stripped !== undefined) {
        const aliased = MODEL_CONTEXT_WINDOWS[stripped];
        if (aliased !== undefined)
            return aliased;
    }
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
/**
 * Resolve the threshold (in **characters**, not tokens) that triggers
 * auto-compaction under the default chars/4 heuristic. Caller-supplied
 * `configured` wins outright — it is interpreted as a raw character count so
 * consumers can opt out of the char-per-token translation entirely. When
 * omitted, the threshold is `getModelContextWindow(model, overrides) *
 * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO`.
 */
export function resolveCompactionThresholdChars(configured, model, overrides) {
    if (configured !== undefined)
        return configured;
    return Math.floor(getModelContextWindow(model, overrides) * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO);
}
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
export function resolveCompactionThresholdTokens(configured, model, overrides, reserveOpts) {
    if (configured !== undefined)
        return configured;
    const window = getModelContextWindow(model, overrides);
    if (reserveOpts === undefined) {
        return Math.floor(window * DEFAULT_THRESHOLD_RATIO);
    }
    const reserve = reserveOpts.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    const buffer = reserveOpts.safetyBufferTokens ?? DEFAULT_SAFETY_BUFFER_TOKENS;
    const floor = Math.floor(window * 0.25);
    return Math.max(floor, window - reserve - buffer);
}
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
export function estimateInstructionsAndToolsTokens(opts) {
    let chars = opts.instructions?.length ?? 0;
    if (Array.isArray(opts.tools)) {
        for (const tool of opts.tools) {
            try {
                const piece = JSON.stringify(tool);
                if (typeof piece === 'string')
                    chars += piece.length;
            }
            catch {
                // Unserializable tool descriptor — skip (defensive; real SDK tool
                // schemas are always JSON-serializable).
            }
        }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
}
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
export function serializeMessagesForEstimate(messages) {
    if (typeof messages === 'string')
        return messages;
    if (!Array.isArray(messages))
        return '';
    let out = '';
    for (const msg of messages) {
        try {
            const piece = JSON.stringify(msg);
            // JSON.stringify(undefined) returns undefined (not a string) — skip,
            // matching the historical "contributes nothing" behavior.
            if (typeof piece === 'string')
                out += piece;
        }
        catch {
            // Cyclic or unserializable items contribute nothing to the estimate —
            // they can't have come from the SDK's own message store, so this is a
            // defensive guard for hand-crafted state in tests.
        }
    }
    return out;
}
/**
 * Char-length heuristic for the SDK's `ConversationState.messages` field —
 * the length of {@link serializeMessagesForEstimate}'s output. Kept as a
 * named export (rather than inlining `.length` at call sites) for back-compat
 * and so the heuristic reads symmetrically with the tokenizer path.
 */
export function estimateMessagesCharLength(messages) {
    return serializeMessagesForEstimate(messages).length;
}
/**
 * Phase 7.2: lower clamp (in **tokens**) for the default token-budgeted keep
 * tail. A tail below ~2k tokens carries too little working context for the
 * model to resume coherently (opencode's exact lower bound).
 */
export const DEFAULT_KEEP_BUDGET_MIN_TOKENS = 2_000;
/**
 * Phase 7.2: upper clamp (in **tokens**) for the default token-budgeted keep
 * tail. Keeping more than ~8k tokens verbatim defeats the point of compacting
 * on the large windows where 25% of usable space would otherwise be 50k+
 * (opencode's exact upper bound).
 */
export const DEFAULT_KEEP_BUDGET_MAX_TOKENS = 8_000;
/**
 * Phase 7.2: fraction of the usable context window targeted by the default
 * keep budget before clamping (opencode: 25% of usable).
 */
export const KEEP_BUDGET_WINDOW_FRACTION = 0.25;
/**
 * Phase 7.2: resolve the default keep-tail budget (in **tokens**):
 * `clamp(floor(window * 0.25), 2k, 8k)`. With no window supplied the
 * {@link DEFAULT_CONTEXT_WINDOW_TOKENS} fallback applies (→ 8k on 128k).
 */
export function resolveKeepBudgetTokens(contextWindowTokens) {
    const window = contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const target = Math.floor(window * KEEP_BUDGET_WINDOW_FRACTION);
    return Math.min(DEFAULT_KEEP_BUDGET_MAX_TOKENS, Math.max(DEFAULT_KEEP_BUDGET_MIN_TOKENS, target));
}
function isRecord(item) {
    return typeof item === 'object' && item !== null;
}
/**
 * A turn boundary: a `user`-role message item (`type` absent or `'message'`).
 * Matches both the SDK's typed item shape and the bare `{ role, content }`
 * shape persisted by earlier sessions.
 */
function isUserMessage(item) {
    if (!isRecord(item))
        return false;
    if (item.role !== 'user')
        return false;
    return item.type === undefined || item.type === 'message';
}
function isFunctionCallOutput(item) {
    return isRecord(item) && item.type === 'function_call_output';
}
function isReasoning(item) {
    return isRecord(item) && item.type === 'reasoning';
}
/** Per-item token estimate: chars/{@link CHARS_PER_TOKEN} of the JSON form. */
function estimateItemTokens(item) {
    return Math.ceil(serializeMessagesForEstimate([item]).length / CHARS_PER_TOKEN);
}
/**
 * Advance `idx` forward to the nearest index that is a VALID tail start:
 * never a `function_call_output` (its `function_call` would be stranded in
 * the summarized prefix — the Responses API hard-400s on an orphaned output)
 * and never an unanchored `reasoning` item (a reasoning item is glued to the
 * item that FOLLOWS it; one with nothing after it is invalid). May return
 * `messages.length` (empty tail) when no valid start exists.
 */
function advanceToValidTailStart(messages, idx) {
    let i = idx;
    while (i < messages.length &&
        (isFunctionCallOutput(messages[i]) || (isReasoning(messages[i]) && i === messages.length - 1))) {
        i++;
    }
    return i;
}
/**
 * Phase 7.2 splitTurn analog (opencode): item-granular fallback for histories
 * where whole-turn keeping is impossible — an oversized single turn, or a
 * history with no user messages at all. Walks backward from the end keeping
 * items while the budget holds, then advances the cut forward to a valid
 * tail start so the tail never opens with an orphaned `function_call_output`
 * or an unanchored `reasoning` item.
 */
function splitTurnCut(messages, from, budgetTokens) {
    let acc = 0;
    let tentative = messages.length;
    for (let i = messages.length - 1; i >= from; i--) {
        acc += estimateItemTokens(messages[i]);
        if (acc > budgetTokens)
            break;
        tentative = i;
    }
    return advanceToValidTailStart(messages, tentative);
}
/**
 * Split a message array into a `summarize` prefix and a `keep` tail.
 *
 * Phase 7.2: the keep tail is **turn-boundary-safe** — it starts at a
 * `user`-role message (a turn boundary), so the rebuilt history never opens
 * with an orphaned `function_call_output` (a hard 400 on the Responses API)
 * or a reasoning item stranded from the item it anchors. Only the keep tail
 * re-enters the conversation as live API items; the summarize prefix is
 * JSON-stringified into the summarizer's input, where item validity does not
 * apply.
 *
 * Two keep modes:
 *
 * - **Token budget (default)** — whole turns are kept newest-first while
 *   their combined chars/{@link CHARS_PER_TOKEN} estimate fits
 *   `keepBudgetTokens` (default {@link resolveKeepBudgetTokens}: 25% of the
 *   window clamped 2k–8k). When even the most recent turn alone exceeds the
 *   budget (a tool-heavy oversized turn), an item-granular splitTurn
 *   fallback keeps the most recent items that fit, advanced to a valid tail
 *   start — never an orphaned fragment.
 * - **`keepRecentTurns` override** — keeps the last N turns verbatim at TRUE
 *   turn granularity (v1 counted messages; a bare number passed for `opts`
 *   selects this mode for back-compat). Fewer than N turns → nothing is
 *   summarized. `0` → everything is summarized.
 *
 * Histories containing no user messages at all (no turn boundaries) fall
 * back to item granularity: the v1 trailing-N slice under
 * `keepRecentTurns`, or the splitTurn budget walk otherwise — in both cases
 * snapped forward to a valid tail start.
 */
export function partitionMessages(messages, opts) {
    const options = typeof opts === 'number' ? { keepRecentTurns: opts } : opts;
    if (messages.length === 0) {
        return { summarize: [], keep: messages };
    }
    const turnStarts = [];
    for (let i = 0; i < messages.length; i++) {
        if (isUserMessage(messages[i]))
            turnStarts.push(i);
    }
    let cut;
    if (options.keepRecentTurns !== undefined) {
        const keepTurns = Math.max(0, Math.floor(options.keepRecentTurns));
        if (keepTurns === 0) {
            cut = messages.length;
        }
        else if (turnStarts.length === 0) {
            // No turn boundaries — v1 message-granularity fallback, snapped to a
            // valid tail start.
            cut = advanceToValidTailStart(messages, Math.max(0, messages.length - keepTurns));
        }
        else if (turnStarts.length < keepTurns) {
            return { summarize: [], keep: messages };
        }
        else {
            cut = turnStarts[turnStarts.length - keepTurns];
        }
    }
    else {
        const budget = options.keepBudgetTokens ?? resolveKeepBudgetTokens(options.contextWindowTokens);
        if (turnStarts.length === 0) {
            cut = splitTurnCut(messages, 0, budget);
        }
        else {
            // Accumulate whole turns newest-first while the budget holds.
            let acc = 0;
            cut = messages.length;
            for (let k = turnStarts.length - 1; k >= 0; k--) {
                const start = turnStarts[k];
                let turnTokens = 0;
                for (let i = start; i < cut; i++)
                    turnTokens += estimateItemTokens(messages[i]);
                if (acc + turnTokens > budget)
                    break;
                acc += turnTokens;
                cut = start;
            }
            if (cut === messages.length) {
                // Even the most recent turn alone exceeds the budget — oversized
                // (tool-heavy) turn. Keep the most recent complete group instead.
                cut = splitTurnCut(messages, turnStarts[turnStarts.length - 1], budget);
            }
        }
    }
    return {
        summarize: messages.slice(0, cut),
        keep: messages.slice(cut),
    };
}
/**
 * Legacy v1 default for the trailing keep window. Phase 7.2: no longer
 * applied implicitly — when `keepRecentTurns` is not supplied, the partition
 * uses the token-budgeted keep tail ({@link resolveKeepBudgetTokens})
 * instead. Exported for back-compat with consumers that referenced the v1
 * default.
 */
export const DEFAULT_KEEP_RECENT_TURNS = 5;
// ——— Phase 7.3: summarizer resilience primitives ———
/**
 * Phase 7.3: per-item character cap applied to tool outputs (and other bulky
 * payloads) when rendering the summarize prefix. Old tool output dominates
 * agentic context but contributes little to a good summary — every surveyed
 * harness truncates it before summarization.
 */
export const SUMMARY_TOOL_OUTPUT_MAX_CHARS = 2_000;
/**
 * Phase 7.3: tokens reserved out of the summarizer model's own context window
 * when budgeting the summarize-call input — the summarizer needs room to
 * *emit* its summary, plus prompt overhead. Mirrors the ~20k output reserve
 * shape used by Claude Code / opencode.
 */
export const SUMMARIZER_INPUT_RESERVE_TOKENS = 20_000;
/**
 * Phase 7.3: maximum number of drop-oldest-and-retry attempts after the
 * summarizer call fails with a context-overflow error (Codex
 * `remove_first_item` loop; Claude Code retries ≤3 seeded from the reported
 * token gap). Non-overflow errors are never retried.
 */
export const MAX_SUMMARIZER_TRIM_RETRIES = 3;
/**
 * Phase 7.3: post-compaction state must be at most this fraction of the
 * pre-compaction char estimate, or the compaction is judged **inflated** —
 * the original state is preserved and the attempt recorded as a failure
 * (Gemini's re-count + restore-if-inflated check). A summary that does not
 * meaningfully shrink the history is pure cache invalidation plus an extra
 * model call.
 */
export const COMPACTION_MIN_SHRINK_RATIO = 0.9;
/**
 * Phase 7.3: number of consecutive AUTO-compaction failures on a session
 * after which the auto-trigger stops firing (circuit breaker). Claude Code's
 * "thrashing" breaker precedent: their telemetry found sessions with 50+
 * consecutive auto-compact failures before the breaker existed. Manual
 * {@link import('./agent.js').OpenRouterAgentRun.compact} calls are always
 * allowed and reset the counter on success.
 */
export const COMPACTION_FAILURE_LIMIT = 3;
/**
 * Phase 7.3: classify an error as a context-window overflow (the only class
 * of summarizer failure worth a drop-oldest retry). The API's error text is
 * the oracle (Claude Code precedent) — matched loosely across providers.
 */
export function isContextOverflowError(err) {
    const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
            ? err
            : err !== null && typeof err === 'object' && 'message' in err
                ? String(err.message)
                : '';
    return /context[ _-]?(?:length|window)|too long|too many tokens|maximum (?:context|.{0,20}tokens)|exceeds? .{0,30}(?:context|token)|prompt is too (?:long|large)|input is too (?:long|large)|\b413\b/i.test(message);
}
/**
 * Phase 7.3: resolve the character budget for the summarize-call input:
 * `max(floor(window × 0.25), window − SUMMARIZER_INPUT_RESERVE_TOKENS)`
 * tokens, translated at {@link CHARS_PER_TOKEN}. The 25% floor keeps tiny /
 * mis-resolved windows from producing a useless (or negative) budget.
 */
export function resolveSummarizerInputBudgetChars(model, overrides) {
    const window = getModelContextWindow(model, overrides);
    const budgetTokens = Math.max(Math.floor(window * 0.25), window - SUMMARIZER_INPUT_RESERVE_TOKENS);
    return budgetTokens * CHARS_PER_TOKEN;
}
function truncateForSummary(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}
/** Render a message `content` field (string or content-block array) as text. */
function renderContentForSummary(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content)) {
        return content === null || content === undefined ? '' : safeStringify(content);
    }
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
            continue;
        }
        if (block === null || typeof block !== 'object')
            continue;
        const b = block;
        const type = typeof b.type === 'string' ? b.type : '';
        if (/image/.test(type)) {
            // Image payloads (base64 or URL) are opaque to a text summarizer —
            // pure token waste (Claude Code strips to '[image]').
            parts.push('[image]');
        }
        else if (/file|document/.test(type)) {
            parts.push('[document]');
        }
        else if (typeof b.text === 'string') {
            parts.push(b.text);
        }
        else {
            parts.push(safeStringify(b));
        }
    }
    return parts.join(' ');
}
function safeStringify(value) {
    try {
        const piece = JSON.stringify(value);
        return typeof piece === 'string' ? piece : '';
    }
    catch {
        return '[unserializable]';
    }
}
/**
 * Phase 7.3: render the summarize prefix as a **readable, role-labelled
 * transcript** instead of `JSON.stringify` of raw SDK items. The summarizer
 * reads prose better than wire JSON, and the rendering:
 *
 * - truncates each tool output to {@link SUMMARY_TOOL_OUTPUT_MAX_CHARS},
 * - replaces image / document payloads with `[image]` / `[document]` markers,
 * - **strips encrypted reasoning content** (`encrypted_content`) entirely —
 *   the summarizer cannot read it and would pay tokens for it; readable
 *   reasoning summaries are kept,
 * - never throws on odd items (unknown shapes render as their JSON with any
 *   `encrypted_content` field removed, truncated).
 */
export function renderMessagesForSummary(messages) {
    if (typeof messages === 'string')
        return messages;
    if (!Array.isArray(messages))
        return '';
    const lines = [];
    for (const item of messages) {
        if (item === null || typeof item !== 'object') {
            if (item !== undefined)
                lines.push(safeStringify(item));
            continue;
        }
        const it = item;
        const type = typeof it.type === 'string' ? it.type : undefined;
        if ((type === undefined || type === 'message') && typeof it.role === 'string') {
            lines.push(`${it.role}: ${renderContentForSummary(it.content)}`);
        }
        else if (type === 'function_call') {
            const name = typeof it.name === 'string' ? it.name : 'unknown_tool';
            const args = typeof it.arguments === 'string' ? it.arguments : safeStringify(it.arguments);
            lines.push(`[tool call] ${name}(${truncateForSummary(args, 500)})`);
        }
        else if (type === 'function_call_output') {
            const output = typeof it.output === 'string' ? it.output : safeStringify(it.output);
            lines.push(`[tool result] ${truncateForSummary(output, SUMMARY_TOOL_OUTPUT_MAX_CHARS)}`);
        }
        else if (type === 'reasoning') {
            // Keep any READABLE reasoning summary; never the encrypted blob.
            const summary = it.summary;
            const readable = Array.isArray(summary)
                ? summary
                    .map((s) => typeof s === 'string'
                    ? s
                    : s !== null &&
                        typeof s === 'object' &&
                        typeof s.text === 'string'
                        ? s.text
                        : '')
                    .filter((s) => s.length > 0)
                    .join(' ')
                : typeof summary === 'string'
                    ? summary
                    : '';
            lines.push(readable.length > 0 ? `[reasoning] ${truncateForSummary(readable, 500)}` : '[reasoning]');
        }
        else {
            // Unknown item shape — keep its JSON (sans encrypted payload) so the
            // summarizer still sees it happened.
            const rest = { ...it };
            delete rest.encrypted_content;
            lines.push(truncateForSummary(safeStringify(rest), SUMMARY_TOOL_OUTPUT_MAX_CHARS));
        }
    }
    return lines.join('\n');
}
// ——— Phase 7.4: tool-output prune tier (no-LLM microcompaction) ———
/**
 * Phase 7.4: marker that replaces a pruned tool output whose content is
 * re-derivable (the agent can re-run the tool). Claude Code's exact wording.
 */
export const PRUNE_CLEARED_MARKER = '[Old tool result content cleared]';
/**
 * Phase 7.4: prefix of the marker that replaces a pruned tool output whose
 * original bytes were offloaded to disk (recoverable — the agent can re-read
 * the file). See {@link pruneStoredMarker}.
 */
export const PRUNE_STORED_MARKER_PREFIX = '[Tool result stored at: ';
/** Phase 7.4: build the offloaded-output marker for a stored file path. */
export function pruneStoredMarker(path) {
    return `${PRUNE_STORED_MARKER_PREFIX}${path}]`;
}
/**
 * Phase 7.4: number of most-recent turns whose tool outputs are never pruned
 * (opencode protects the last 2 turns). A turn starts at a `user`-role
 * message.
 */
export const PRUNE_PROTECT_RECENT_TURNS = 2;
/**
 * Phase 7.4: most-recent tool-output budget (in tokens, chars/4 estimate)
 * protected from pruning, accumulated newest-first (opencode: most recent
 * 40k tokens of tool output survive).
 */
export const PRUNE_PROTECT_RECENT_TOKENS = 40_000;
/**
 * Phase 7.4: minimum estimated reclaim (in tokens) for a prune to commit.
 * Pruning rewrites the prefix and therefore costs one prompt-cache miss —
 * a prune that reclaims less than this is pure cache invalidation
 * (opencode: >20k tokens or skip).
 */
export const PRUNE_MIN_RECLAIM_TOKENS = 20_000;
/**
 * Phase 7.4: tools whose outputs are never pruned by default. opencode
 * protects `skill` (skill bodies ARE the operating instructions). Hosts can
 * extend the list per run — e.g. add `spawn_subagent` to keep subagent
 * results — via the agent's `pruneProtectedTools` option.
 */
export const DEFAULT_PRUNE_PROTECTED_TOOLS = Object.freeze(['skill']);
/**
 * Phase 7.4: tools whose pruned outputs are CLEARED rather than offloaded to
 * disk even when the session persists — their content is cheaply
 * re-derivable by re-running the tool (Claude Code clears these first).
 */
export const PRUNE_REDERIVABLE_TOOLS = Object.freeze([
    'read_file',
    'grep_files',
    'glob',
    'list_directory',
    'run_command',
]);
function pruneIsUserMessage(item) {
    if (item === null || typeof item !== 'object')
        return false;
    const it = item;
    return it.role === 'user' && (it.type === undefined || it.type === 'message');
}
/**
 * Phase 7.4: plan a zero-LLM-call tool-output prune. Walks the history
 * newest→oldest and selects older `function_call_output` items whose string
 * content can be replaced in place with a marker, protecting:
 *
 * - everything inside the most recent `protectRecentTurns` turns (turn =
 *   starts at a `user`-role message; when no user messages exist the last
 *   item alone is protected),
 * - the most recent `protectRecentTokens` worth of tool output (newest
 *   first) outside that window,
 * - outputs of `protectedTools` (resolved from the paired `function_call`'s
 *   `name` via `call_id`; unresolvable names are treated as protected —
 *   fail-safe),
 * - already-pruned outputs (cleared / stored-at markers), and
 * - non-string outputs (no in-place text replacement is meaningful).
 *
 * The plan commits only when the estimated reclaim exceeds
 * `minReclaimTokens` — otherwise an empty plan is returned and the caller
 * skips (a small prune is pure prompt-cache invalidation). The message /
 * tool-call **skeleton stays intact**: only `output` strings are replaced,
 * so the model still sees that the calls happened.
 */
export function planToolOutputPrune(messages, opts = {}) {
    const empty = { candidates: [], reclaimedTokens: 0 };
    if (!Array.isArray(messages) || messages.length === 0)
        return empty;
    const protectTurns = opts.protectRecentTurns ?? PRUNE_PROTECT_RECENT_TURNS;
    const protectTokens = opts.protectRecentTokens ?? PRUNE_PROTECT_RECENT_TOKENS;
    const protectedTools = new Set(opts.protectedTools ?? DEFAULT_PRUNE_PROTECTED_TOOLS);
    const minReclaim = opts.minReclaimTokens ?? PRUNE_MIN_RECLAIM_TOKENS;
    // call_id → tool name, from the function_call items.
    const namesByCallId = new Map();
    for (const item of messages) {
        if (item === null || typeof item !== 'object')
            continue;
        const it = item;
        if (it.type === 'function_call' &&
            typeof it.call_id === 'string' &&
            typeof it.name === 'string') {
            namesByCallId.set(it.call_id, it.name);
        }
    }
    // Start of the protected turn window: the protectTurns-th user message
    // from the end. No user messages → protect only the very last item.
    let protectedFrom = messages.length - 1;
    let turnsSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (pruneIsUserMessage(messages[i])) {
            turnsSeen += 1;
            protectedFrom = i;
            if (turnsSeen >= protectTurns)
                break;
        }
    }
    if (turnsSeen === 0)
        protectedFrom = messages.length - 1;
    const candidates = [];
    let reclaimed = 0;
    let recentOutputTokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const item = messages[i];
        if (item === null || typeof item !== 'object')
            continue;
        const it = item;
        if (it.type !== 'function_call_output')
            continue;
        if (typeof it.output !== 'string')
            continue;
        if (it.output === PRUNE_CLEARED_MARKER || it.output.startsWith(PRUNE_STORED_MARKER_PREFIX)) {
            continue;
        }
        const outputTokens = Math.ceil(it.output.length / CHARS_PER_TOKEN);
        // The most recent `protectTokens` of tool output (newest first across
        // the WHOLE history — outputs inside the protected turn window consume
        // this budget too) survives.
        if (recentOutputTokens < protectTokens) {
            recentOutputTokens += outputTokens;
            continue;
        }
        // Everything inside the protected turn window survives regardless.
        if (i >= protectedFrom)
            continue;
        const callId = typeof it.call_id === 'string' ? it.call_id : undefined;
        const toolName = callId !== undefined ? namesByCallId.get(callId) : undefined;
        // Unresolvable tool names are protected — never blindly destroy output
        // we cannot classify.
        if (toolName === undefined || protectedTools.has(toolName))
            continue;
        candidates.push({
            index: i,
            ...(callId !== undefined && { callId }),
            toolName,
            output: it.output,
            outputTokens,
        });
        reclaimed += outputTokens;
    }
    if (reclaimed < minReclaim)
        return empty;
    candidates.reverse(); // oldest first, for stable offload naming/logging
    return { candidates, reclaimedTokens: reclaimed };
}
//# sourceMappingURL=compaction.js.map