import { type Tool } from '@openrouter/agent';
import type { AnthropicCacheControlDirective } from '@openrouter/sdk/models';
import { type SkillLoader } from './skills/index.js';
import type { OnAskUserQuestion } from './tools/ask-user-question.js';
import type { OnTasksChanged } from './tools/tasks.js';
import type { AgentCoreEvent, HookEvent, HookPayload, PreToolUseAction } from './events.js';
import { type PermissionMode } from './permission-modes.js';
import { type SettingSource } from './context-discovery.js';
import { type AgentMessage } from './messages.js';
import { type ForkSessionResult } from './session-fork.js';
import { type McpServerConfig } from './mcp/config.js';
import type { LoadedPlugin } from './plugins/index.js';
import { type UserInput } from './streaming-input.js';
/**
 * Default system instructions for the built-in code-editing agent. Exported so
 * library consumers can extend, prefix, or replace the string without
 * re-deriving it from source.
 */
export declare const DEFAULT_INSTRUCTIONS = "You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.";
export type AgentLoggerLevel = 'debug' | 'info' | 'warn' | 'error';
export type AgentLogger = (level: AgentLoggerLevel, message: string, fields?: Record<string, unknown>) => void;
export type CanUseToolResult = {
    behavior: 'allow';
    updatedInput?: unknown;
} | {
    behavior: 'deny';
    reason: string;
};
/**
 * Phase 5.4: normalized reasoning-depth knob accepted by OpenRouter's
 * `reasoning.effort` field. OR maps the requested level to each provider's
 * native parameter (OpenAI `reasoning_effort`, Anthropic `thinking.budget_tokens`,
 * Gemini `thinkingConfig.thinkingLevel`, Qwen `thinking_budget`, xAI
 * `reasoning_effort`) and substitutes the nearest supported level when a model
 * lacks the requested one. Ignored by non-reasoning models.
 */
export type EffortLevel = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
/**
 * Context passed as the 3rd argument to {@link CanUseTool}. Matches the
 * Claude Code SDK's permission-callback context shape so consumers porting a
 * Claude-shaped `canUseTool` between SDKs can destructure `{ signal }` /
 * `{ suggestions }` without a runtime trap (issue #196).
 *
 * - `signal`: aborts when the surrounding tool call is cancelled (either by
 *   run interruption or by a hook/permission decision elsewhere in the
 *   pipeline). Always present so destructure-style consumers don't see
 *   `undefined`; check `.aborted` before kicking off slow permission UIs.
 * - `suggestions`: forward-compat slot for permission-mode suggestion lists
 *   the host UI might surface alongside the prompt. Always an array; empty
 *   on this implementation today.
 */
export interface CanUseToolContext {
    signal: AbortSignal;
    suggestions: readonly unknown[];
}
export type CanUseTool = (toolName: string, input: unknown, ctx: CanUseToolContext) => Promise<CanUseToolResult> | CanUseToolResult;
/**
 * Lifecycle hook callback. Invoked with a {@link HookEvent} discriminator and
 * the matching {@link HookPayload} variant. Hooks are awaited; thrown errors
 * are logged via {@link AgentLogger} and swallowed (a throw is NEVER treated
 * as a block — that would silently flip a working hook from "allow + recover"
 * to "deny" if the handler later starts throwing).
 *
 * For the `PreToolUse` event specifically, the handler MAY return a
 * {@link PreToolUseAction} to short-circuit (`block`) or rewrite (`modify`)
 * the tool call before {@link CanUseTool} runs. Returning `void`/`undefined`
 * (the historical contract) is equivalent to `{ action: 'continue' }` — the
 * tool call proceeds with the original input. Every other event's return
 * value is ignored.
 *
 * Order of evaluation per tool call when both `onHook` and `canUseTool` are
 * set:
 * 1. `PreToolUse` fires. `block` → synth-denial tool result, `PostToolUse`
 *    still fires with `isError: true`; `modify` → effective input becomes
 *    the substituted value.
 * 2. `canUseTool` runs against the (possibly modified) input.
 * 3. The underlying tool executes if both steps allow.
 *
 * Precedence: hook-`block` beats `canUseTool`-allow (canUseTool is never
 * consulted on block). `canUseTool`-`deny` beats hook-`continue`/`modify`
 * (deny short-circuits whatever the hook permitted).
 */
export type OnHook = (event: HookEvent, payload: HookPayload) => void | PreToolUseAction | Promise<void | PreToolUseAction>;
export interface OpenRouterAgentRunOptions {
    /** OpenRouter API key. Required — no env fallback. */
    apiKey: string;
    /** Stable session id used for OR's server-side session tracking and on-disk state. */
    sessionId: string;
    /**
     * The user prompt for this run.
     *
     * - `string` — single-shot single-turn behavior (back-compat with all prior
     *   phases). The string is wrapped as the first user message; the run
     *   terminates after the resulting `callModel` returns (or after any
     *   subsequent imperative {@link OpenRouterAgentRun.pushUserMessage} calls
     *   drain).
     * - `AsyncIterable<UserInput>` — Phase 5.3 streaming-input mode. The first
     *   yielded {@link UserInput} starts the first turn; subsequent yields
     *   queue for the next turn. End-of-iteration (`{ done: true }`) closes the
     *   run after the in-flight `callModel` finishes. See README "Streaming
     *   input" subsection for the full semantics.
     *
     * Combine with {@link OpenRouterAgentRun.pushUserMessage} / `interrupt()`
     * for mid-run control. Image / file attachments ride on `UserInput.content`
     * as a `ReadonlyArray<unknown>` of OR-shaped content blocks.
     */
    prompt: string | AsyncIterable<UserInput>;
    /** System instructions. Defaults to {@link DEFAULT_INSTRUCTIONS}. */
    instructions?: string;
    /** Model alias or id. Defaults to `~anthropic/claude-sonnet-latest`. */
    model?: string;
    /** Working directory tools resolve relative paths against. Defaults to the host process's current directory. */
    cwd?: string;
    /** Max inner-loop turns. Defaults to 25. */
    maxTurns?: number;
    /** Max cumulative cost in USD. Defaults to 1.0. */
    maxBudgetUsd?: number;
    /**
     * Maximum number of automatic retries when a `callModel` cycle dies with a
     * TRANSIENT terminal failure — a `response.failed` SSE event whose error
     * code is `server_error` / `overloaded`, or an HTTP 5xx error from the SDK.
     * Deterministic failures (4xx-class errors, moderation blocks, context
     * overflow) and abort/interrupt paths are never retried.
     *
     * Each retry re-issues the same cycle with the same fresh input after a
     * short exponential backoff (see {@link transientRetryBaseDelayMs}). This is
     * safe by SDK design: the OR Agent SDK persists a cycle's fresh user items
     * atomically with the assistant output only after a response completes, so
     * a cycle that failed before its first completed response left state
     * untouched; when a follow-up turn failed instead, the retry continues from
     * the already-persisted history without re-sending the fresh items — user
     * items never appear twice in state. Each attempt is logged at `warn` level
     * via {@link AgentLogger} with the failure reason and attempt number.
     *
     * Inherited by spawned subagents. Set `0` to disable retries entirely
     * (every transient failure becomes terminal, the pre-0.2.2 behavior).
     * Defaults to {@link DEFAULT_MAX_TRANSIENT_RETRIES} = 2.
     */
    maxTransientRetries?: number;
    /**
     * Base delay in milliseconds for the exponential backoff between transient
     * -failure retries: retry N (0-based) sleeps `base * 2^N` ms before
     * re-issuing the cycle. The sleep is abort-aware — an abort during the
     * backoff window cancels the pending retry and unwinds as a normal abort.
     * Inherited by spawned subagents. Defaults to
     * {@link DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS} = 500.
     */
    transientRetryBaseDelayMs?: number;
    /**
     * Hung-stream watchdog: when the SSE event stream produces NO events for
     * this many milliseconds while NO client tool execution is in flight, the
     * cycle fails with a {@link StreamStallError}. Dead upstream connections
     * otherwise hang a run forever — the OR Responses wire is unidirectional
     * SSE with no heartbeat, so a silently dropped connection produces no
     * error, no close, and no further events.
     *
     * Tool executions legitimately silence the stream (a 5-minute `bash` run
     * emits no SSE traffic while it works), so the stall clock is suspended
     * while any client tool's execute is in flight and resets when it
     * settles. The watchdog covers only the active stream drain — it is not
     * armed between cycles or during the post-stream response fetch.
     *
     * A stall is classified as TRANSIENT: the bounded retry machinery
     * ({@link maxTransientRetries} / {@link transientRetryBaseDelayMs})
     * tears down the dead stream and re-issues the cycle with the usual
     * backoff, so a single dropped connection self-heals. With retries
     * exhausted (or disabled) the run ends with `stream_complete{status:
     * 'error'}` carrying the stall reason.
     *
     * Inherited by spawned subagents. Set `0` to disable stall detection
     * entirely. Defaults to {@link DEFAULT_STREAM_STALL_TIMEOUT_MS} = 120_000
     * (2 minutes).
     */
    streamStallTimeoutMs?: number;
    /**
     * Per-tool execute deadline in milliseconds. When a client tool's
     * `execute` has not settled after this long, the harness stops waiting
     * and surfaces the timeout as the tool result: the wrapper throws
     * `JSON.stringify({ error: 'tool <name> timed out after <N>ms',
     * timedOut: true })` — mirroring the `canUseTool` deny convention — so
     * the SDK emits a normal `function_call_output` envelope and the
     * consumer sees `tool_result.isError: true` with a machine-checkable
     * `timedOut` marker after a double `JSON.parse`. The run continues; the
     * model can react to the failure.
     *
     * Exempt tools (never wrapped):
     * - `bash` — has its own timeout with a model-controllable `timeout_ms`
     *   input field (default 30s, clamped to 10 min).
     * - `spawn_subagent` / `spawn_subagents` — long-running by design;
     *   subagents are bounded by their own `maxTurns` / `maxBudgetUsd`.
     * - `ask_user_question` — blocks on a HUMAN answering via the host's
     *   `onAskUserQuestion` handler; a person stepping away for lunch is not
     *   a tool failure.
     * - `monitor` — waits on external output by design and carries its own
     *   `max_duration_ms` input (default 60s, clamped to 10 min).
     * - `skill` — `context: fork` skills drive an entire subagent run inside
     *   their execute (bounded like spawned subagents).
     * - MCP-bridged tools (names containing the `__` separator, i.e.
     *   `<serverName>__<toolName>`) — external servers own their timeout
     *   semantics.
     *
     * The wrapper composes INNERMOST (around the context-bound execute,
     * inside the permission/hook wrappers) so `PostToolUse` and the
     * `tool_result` both reflect the timeout error. Note: v1 does NOT cancel
     * the underlying I/O — there is no abort-signal plumbing into the losing
     * execute; the loop just stops waiting and the orphaned promise's later
     * settlement is swallowed.
     *
     * Inherited by spawned subagents. Set `0` to disable the deadline.
     * Defaults to {@link DEFAULT_TOOL_TIMEOUT_MS} = 60_000 (1 minute).
     */
    toolTimeoutMs?: number;
    /**
     * Tool set passed to the model. Defaults to the built-in 12-client-tool set
     * bound to a {@link ToolContext} derived from the run's `cwd` and composite
     * AbortSignal; server tools (datetime/web_search/web_fetch) are injected via
     * hooks. Custom tools supplied here are NOT context-bound — callers are
     * responsible for their own cwd resolution and cancellation if needed.
     */
    tools?: readonly Tool[];
    /**
     * Host callback that powers the built-in `ask_user_question` tool. The
     * callback receives a {@link UserQuestionRequest} (UUID `questionId`,
     * question text, options with auto-assigned ids `a`/`b`/`c`…, optional
     * `allowFreeText` flag) and must resolve with a {@link UserQuestionResponse}
     * carrying the user's choice. When omitted, the tool surfaces an
     * `{ error: 'no host handler registered for ask_user_question' }` tool
     * result so the model can recover gracefully. Ignored when a custom `tools`
     * array is supplied (callers wire their own `ask_user_question` if needed).
     *
     * The same request payload is also pushed via the `Notification` hook
     * (level `'info'`, message `'ask_user_question'`, context = the request),
     * so subscribers that only listen on `onHook` still observe the question.
     */
    onAskUserQuestion?: OnAskUserQuestion;
    /**
     * Convenience callback fired after every `task_create` / `task_update`
     * mutation with the full latest task list (defensive shallow-copy — safe
     * to retain). Equivalent to filtering the `Notification` hook on
     * `message === 'tasks_changed'`; supply this when the host doesn't want to
     * subscribe to every Notification just to render the task list. Threaded
     * into the default tool bundle only — ignored when a custom `tools` array
     * is supplied (callers wire their own `task_create` / `task_update` if
     * needed).
     */
    onTasksChanged?: OnTasksChanged;
    /**
     * Permission gate invoked before each client tool's execute. Resolve to
     * `{ behavior: 'allow' }` to run the handler as-is, `{ behavior: 'allow',
     * updatedInput }` to substitute the handler's input, or `{ behavior:
     * 'deny', reason }` to skip the handler and surface a denial as the tool
     * result. Errors thrown from this callback are treated as denials using
     * the thrown message. Server-side tools (datetime/web_search/web_fetch)
     * execute on OpenRouter's servers and bypass this hook.
     */
    canUseTool?: CanUseTool;
    /**
     * Named permission preset translated into a {@link CanUseTool} internally.
     * See {@link PermissionMode} for the per-mode allow/deny matrix. When both
     * `permissionMode` and an explicit `canUseTool` are supplied, `canUseTool`
     * wins (explicit > implicit) and a `'warn'`-level log is emitted via
     * {@link AgentLogger}. Omit to default to "allow all" (parity with the prior
     * release).
     */
    permissionMode?: PermissionMode;
    /**
     * Pre-approve list of tool invocations. Entries are either a plain tool name
     * (`'read_file'`, also accepts the Claude-SDK-style alias `'Read'`) or a
     * scoped rule (e.g. `'Bash(npm *)'` or `'Edit(src/handlers.ts)'`; globs
     * support `*` and `**`). A matching rule short-circuits the
     * {@link permissionMode} gate to allow that call. Rules are validated at
     * construction — malformed input throws immediately.
     *
     * When `disallowedTools` matches the same call, the denial wins. Explicit
     * `canUseTool` overrides both lists entirely.
     */
    allowedTools?: readonly string[];
    /**
     * Deny list of tool invocations using the same grammar as
     * {@link allowedTools}. Denials win over both {@link allowedTools} matches
     * and the {@link permissionMode} gate. Explicit `canUseTool` overrides this
     * list entirely.
     */
    disallowedTools?: readonly string[];
    /**
     * Lifecycle hook callback. Fire order on the happy path:
     *
     * `Setup` (once, before any other hook — useful for first-run resource
     * provisioning) → `SessionStart` (after the `session_started` event yields,
     * with `sessionId`/`cwd`/`model`) → for each tool call: `PreToolUse`
     * (audit, fires even when `canUseTool` denies) → `PostToolUse` (with
     * `isError` matching the subsequent `tool_result.isError`) → `SessionEnd`
     * (after `stream_complete`, with final status/usage/cost) → `Stop` (last
     * hook in the run, carries the final status + an optional `reason` on
     * abort or thrown-error paths).
     *
     * `Notification` is the only hook event that is NOT auto-fired. Library
     * code or custom tools push it via {@link ToolContext.notify} (or by
     * calling `onHook` directly) to surface progress/errors to subscribers.
     *
     * `Setup` and `Stop` always bracket the run — including when the OR
     * client constructor throws or the run is aborted before any model
     * traffic. Hooks are awaited; thrown errors are logged via
     * {@link AgentLogger} and swallowed so they cannot break a run.
     */
    onHook?: OnHook;
    /**
     * External AbortSignal. When aborted, the run cancels the underlying OR
     * stream and propagates SIGTERM (then SIGKILL after a 250ms grace) to any
     * child process spawned by `bash`. Combined internally with the
     * `abort()` method via `AbortSignal.any`.
     */
    signal?: AbortSignal;
    /** Override for the logs directory. Defaults to `<cwd>/logs`. */
    logsRoot?: string;
    /** Override the OpenRouter API base URL. */
    baseUrl?: string;
    /** App title sent in OR client metadata. Defaults to `'openrouter-agent-harness'`. */
    appTitle?: string;
    /** Optional diagnostic logger. No logger → silent. */
    logger?: AgentLogger;
    /**
     * Opt-in context-discovery sources. When non-empty, the agent walks each
     * source on the first iteration and **prepends** the discovered CLAUDE.md
     * content to {@link instructions} (or {@link DEFAULT_INSTRUCTIONS} when
     * unset). Final composed order is: `user` → `project` → `local` →
     * constructor `instructions`.
     *
     * Sources:
     * - `'project'` — walks up from `cwd`, picking up `<dir>/CLAUDE.md` and
     *   `<dir>/.claude/CLAUDE.md` at each level. Stops at the first directory
     *   containing `.git`, or at the filesystem root. Walk depth capped at 10.
     * - `'user'` — `<os.homedir()>/.claude/CLAUDE.md`.
     * - `'local'` — `<cwd>/.claude/CLAUDE.local.md`.
     *
     * Missing or unreadable files are silently skipped. The composed
     * instructions are capped at ~50k characters; on overflow the agent drops
     * contributions from the oldest source (user → project → local) and emits
     * a `'warn'`-level log via {@link logger}.
     *
     * Defaults to `[]` (back-compat: no discovery, no FS reads).
     */
    settingSources?: readonly SettingSource[];
    /**
     * When `false`, the run uses an in-memory {@link StateAccessor} and skips
     * every write under {@link logsRoot} — no `session.json`, no per-request
     * `request.json`, no per-generation `response.json`, no `state.json`. The
     * session is still tracked server-side via `sessionId`, hooks still fire,
     * and the event stream is byte-identical to a persisted run.
     *
     * Trade-offs: no resume across processes (the next process won't see
     * anything for this sessionId under `logsRoot`), and external readers of
     * the on-disk log (e.g. {@link readSessionLog} from Phase 1.6) will get
     * ENOENT for that sessionId.
     *
     * Defaults to `true` (back-compat: persist everything).
     */
    persistSession?: boolean;
    /**
     * Phase 4.6: when `true`, the built-in `write_file` and `edit_file` tools
     * snapshot their target path into the session's `checkpoints/` directory
     * **before** mutating it. Per-tool-call `checkpoint` field on those tools'
     * input schemas overrides this default. Defaults to `false` — no
     * auto-checkpointing.
     *
     * When the run is constructed with `persistSession: false`, requested
     * checkpoints become a NO-OP (in-memory sessions have no disk path to
     * persist snapshots to). The library emits a `'warn'`-level log via
     * {@link logger} when a checkpoint is requested but skipped, and the
     * underlying write proceeds normally.
     *
     * Ignored when the caller supplies a custom `tools` array — checkpointing
     * is a built-in-tools-only convenience.
     */
    checkpoint?: boolean;
    /**
     * Set when this run continues a session that was forked from another
     * (Phase 4.5). Threaded into the `session.json` that {@link logSessionStart}
     * writes, and surfaced on the `session_started` event payload so consumers
     * can render the lineage. Defaults to undefined — the field is omitted from
     * both on-disk and event payloads for root sessions.
     *
     * The library does NOT itself look up or validate the parent. Callers can
     * pair this with {@link forkSession} (or the {@link OpenRouterAgentRun.fork}
     * helper) to mint a child session id, then construct the next run with
     * `parentSessionId: <source>`.
     */
    parentSessionId?: string;
    /**
     * Phase 4.7: opt the built-in `spawn_subagent` tool into the default tool
     * bundle. When `true`, the agent appends `spawn_subagent` to the bundle
     * and wires an internal `SubagentRunner` that constructs child
     * {@link OpenRouterAgentRun}s with the parent's `apiKey` / `baseUrl` /
     * `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` /
     * `persistSession` inherited. Each child gets a fresh session id
     * (`<parentSessionId>:sub:<uuid>`) and `currentSubagentDepth =
     * parent + 1`.
     *
     * Defaults to `false` — subagent spawning stays an explicit, opt-in
     * feature (NOT in the default bundle). Ignored when the caller supplies
     * a custom `tools` array (callers wire their own `spawn_subagent` via
     * {@link spawnSubagentTool} if they need it).
     */
    enableSubagents?: boolean;
    /**
     * Maximum chain depth for subagent recursion (root counts as `0`).
     * Default {@link DEFAULT_MAX_SUBAGENT_DEPTH} = 3 — `spawn_subagent` is
     * allowed from depths `0`, `1`, `2` and rejects from depth `3`,
     * yielding a chain of at most three levels (parent → sub → sub-sub →
     * reject 4th). Threaded into every spawned subagent so the cap is
     * uniform across the whole chain.
     */
    maxSubagentDepth?: number;
    /**
     * Phase 4.7: this run's own position in the subagent chain (root = `0`,
     * first subagent = `1`, …). Set internally by the `spawn_subagent` tool
     * when constructing a child run — external callers should leave this
     * undefined (the default `0`).
     */
    currentSubagentDepth?: number;
    /**
     * Phase 4.9: maximum number of subagents allowed in-flight at once for a
     * single `spawn_subagents` (plural) invocation. Default
     * {@link DEFAULT_MAX_PARALLEL_SUBAGENTS} = 4 — picked as a balance
     * between OR API back-pressure (each child opens its own stream) and
     * meaningful parallelism on typical fan-outs. The plural tool's array
     * may be longer than the cap; excess specs queue and are submitted in
     * order as workers free up. Threaded into every spawned subagent so the
     * cap propagates uniformly down the chain (a depth-N subagent's own
     * plural spawns honor the same value). Ignored when the caller supplies
     * a custom `tools` array.
     */
    maxParallelSubagents?: number;
    /**
     * Phase 5.4: per-run reasoning-depth override. Forwarded into the OR
     * `callModel` call as `reasoning: { effort }` ONLY when set — omitted runs
     * never send a `reasoning` payload, preserving each model's default behavior.
     * See {@link EffortLevel} for the enum semantics and per-provider mapping.
     */
    effort?: EffortLevel;
    /**
     * OpenRouter's auto-prompt-cache directive. When set, the value is
     * forwarded as the top-level `cacheControl` field on the `callModel`
     * request body — OR then automatically applies cache breakpoints to the
     * last cacheable block in the request. This is a request-level hint, NOT
     * a per-content-block `cache_control` (see `@openrouter/sdk`'s
     * `AnthropicCacheControlDirective` JSDoc). Currently honored only by
     * Anthropic Claude models; other providers ignore it. Omitted runs send
     * no `cacheControl` field on the wire (preserves default behavior).
     * Inherited by spawned subagents unless the spawn config overrides it,
     * and also rides the compaction `callModel` so summarization prompts
     * benefit from the same cache.
     */
    cacheControl?: AnthropicCacheControlDirective;
    /**
     * When `true`, skip OpenRouter's built-in server-side tool injection
     * (`openrouter:datetime`, `openrouter:web_search`, `openrouter:web_fetch`).
     * Default `false` — server tools remain active, preserving prior behavior.
     *
     * Why this exists: empirically, the presence of those three server tools
     * in the request body disables OR's `cacheControl` auto-prompt-caching on
     * Anthropic models when combined with user-defined tools (the cache-key
     * path OR uses to forward to Anthropic appears to be invalidated by the
     * server-tools rewrite). Setting this to `true` keeps the request's
     * `tools` array exactly as built by the agent, restoring caching at the
     * cost of losing OR's server-side datetime/web access.
     *
     * Inherited by spawned subagents unless the spawn config overrides.
     * Applies to both the main run client and the compaction client (which
     * share `createOpenRouterClient`).
     */
    disableServerTools?: boolean;
    /**
     * Phase 5.1: threshold that triggers an auto-compaction pass once the
     * persisted `ConversationState.messages` array crosses it.
     *
     * **Unit depends on {@link tokenCounter}.** Without a `tokenCounter`
     * (the back-compat default), the value is a raw CHARACTER count compared
     * against the serialized message history, defaulting to
     * `getModelContextWindow(model, modelContextWindows) * 4 * 0.8` — i.e.
     * ~80% of the model's token budget converted at the conservative
     * chars-per-token ratio. With a `tokenCounter` supplied, the value is a
     * TOKEN count compared against the counter's output, defaulting to
     * `floor(getModelContextWindow(model, modelContextWindows) * 0.8)`.
     *
     * Honoured only when {@link autoCompact} is not `false`.
     */
    compactionThreshold?: number;
    /**
     * Per-run overrides for the static {@link MODEL_CONTEXT_WINDOWS} table
     * used to derive the default {@link compactionThreshold}. Keys are model
     * ids; values are context-window sizes in TOKENS. Resolution order:
     * override exact match → override with the `~` alias prefix stripped →
     * static-table exact match → static-table alias →
     * `DEFAULT_CONTEXT_WINDOW_TOKENS` (128k). Lets hosts teach the harness
     * about models the shipped table doesn't know (or correct entries that
     * drifted) without waiting for a library release. Inherited by spawned
     * subagents. Defaults to undefined — the static table alone.
     */
    modelContextWindows?: Readonly<Record<string, number>>;
    /**
     * Real tokenizer hook for the auto-compaction estimate. When supplied,
     * the post-run threshold check serializes the persisted message history
     * (the same serialization the chars/4 heuristic measures — see
     * {@link serializeMessagesForEstimate}), passes it to this callback, and
     * compares the returned TOKEN count against a token threshold
     * (`compactionThreshold` when set — reinterpreted as TOKENS — otherwise
     * `floor(getModelContextWindow(model, modelContextWindows) * 0.8)`).
     * Without it, the chars/4 heuristic and character thresholds apply
     * (back-compat default).
     *
     * Must be synchronous and total: if the callback throws, the harness
     * logs a `'warn'` via {@link logger} and falls back to the char
     * heuristic for that check (the run never dies on a tokenizer bug).
     * Inherited by spawned subagents.
     */
    tokenCounter?: (serializedMessages: string) => number;
    /**
     * Phase 5.1: number of trailing messages (NOT strict turns — see
     * {@link partitionMessages} JSDoc for the granularity note) preserved
     * verbatim during compaction. Everything older is condensed into a single
     * `developer`-role summary message. Defaults to
     * {@link DEFAULT_KEEP_RECENT_TURNS} = 5.
     */
    keepRecentTurns?: number;
    /**
     * Phase 5.1: when `false`, suppresses the post-`stream_complete`
     * threshold check that automatically fires compaction between runs that
     * share a `sessionId`. The manual {@link OpenRouterAgentRun.compact}
     * method still works regardless of this setting — `autoCompact: false`
     * gates ONLY the implicit trigger. Defaults to `true`.
     */
    autoCompact?: boolean;
    /**
     * Phase 5.2.4: explicit list of MCP servers to spawn for this run.
     * When set, {@link autoDiscoverMcp} is ignored and the bridge uses this
     * array verbatim. Each entry is the discriminated union from
     * `src/mcp/config.ts` — stdio (`command`, optional `args`/`env`) or http
     * (`url`, optional `headers`). Servers are spawned lazily at the top of
     * {@link OpenRouterAgentRun.iterate} (after the `Setup` hook), their tools
     * are listed via the `initialize` handshake, and each tool surfaces in the
     * run's tool array under the prefixed name `<serverName>__<toolName>`.
     *
     * Per-server init failures DO NOT crash the run — the bridge logs via
     * {@link logger}, fires a `Notification` hook with
     * `message: 'mcp_server_failed'`, and continues with the remaining servers.
     *
     * Lifecycle is per-run: the bridge spawns at iter start and tears down in
     * the `finally` block (success / abort / throw).
     *
     * Defaults to undefined → falls through to {@link autoDiscoverMcp}.
     */
    mcpServers?: readonly McpServerConfig[];
    /**
     * Phase 5.2.4: when {@link mcpServers} is undefined, controls whether
     * the agent runs {@link loadMcpConfig} from `cwd` + the user scope to
     * auto-spawn discovered MCP servers. **Defaults to `false`** — silently
     * auto-spawning user subprocesses from a library constructor is surprising
     * behaviour for hosts embedding this package, so the opt-in is explicit.
     * Set to `true` to mirror Claude Code's "scan `.mcp.json` and start
     * everything" behaviour. Ignored when {@link mcpServers} is set.
     */
    autoDiscoverMcp?: boolean;
    /**
     * Phase 5.5: opt the built-in `tool_search` + `tool_load` tools into the
     * default tool bundle. When `true`, the agent appends both tools to the
     * bundle AND hides every MCP bridge tool from the model's tool list until
     * the model explicitly calls `tool_load`. The model uses `tool_search` to
     * discover tools (returns name / server / description / truncated
     * schema_preview / score) and then `tool_load({ names: [...] })` to
     * register one or more tools for the rest of the run. Each successful
     * load fires a `Notification` hook (`info`, `tool_loaded`) so audit
     * consumers can observe the working-set growth.
     *
     * The "hidden until loaded" gate is the whole point — it converts the
     * MCP catalog from a context-budget tax (every schema sent on every turn)
     * to an opt-in lookup. When MCP servers are configured but
     * `enableToolSearch` is `false`, the prior Phase 5.2.4 behaviour is
     * preserved (every bridge tool is unconditionally visible to the model).
     *
     * Defaults to `false`. Ignored when the caller supplies a custom `tools`
     * array (callers wire their own `tool_search` / `tool_load` via the
     * exported {@link toolSearchTool} / {@link toolLoadTool} factories if
     * they need to). Loaded-tool state is per-run and does NOT propagate to
     * spawned subagents — subagents see whatever tool pool their own
     * constructor opts produce.
     */
    enableToolSearch?: boolean;
    /**
     * Phase 5.7: opt-in skill registry. When set, the agent appends the `skill`
     * built-in tool to the default bundle and injects a `## Available Skills`
     * block into the system instructions (within {@link skillDescriptionBudget})
     * so the model can pick a skill by name. Skills whose listing was dropped
     * over budget remain callable by exact name but won't auto-trigger.
     *
     * Pass either a pre-built {@link SkillLoader} (host has already configured
     * its scopes), or rely on {@link skillsDir} below to construct one from
     * `cwd`. Ignored when the caller supplies a custom `tools` array.
     */
    skills?: SkillLoader;
    /**
     * Phase 5.7: convenience for the common case where the host just wants
     * project-scope `.claude/skills/` + user-scope `~/.claude/skills/` discovery
     * with no plugin roots. When set, the agent constructs a default
     * {@link SkillLoader} bound to this path. Ignored when {@link skills} is
     * also set (the explicit loader wins).
     */
    skillsDir?: string;
    /**
     * Phase 5.7: max fraction of the model's context window to spend on the
     * skill listing block injected into the system prompt. Defaults to
     * {@link DEFAULT_SKILL_DESCRIPTION_BUDGET} (~1%). Skills overflowing the
     * budget are dropped from the listing in source-precedence + alphabetical
     * order; the loader still knows them and they can be invoked by exact name.
     */
    skillDescriptionBudget?: number;
    /**
     * Phase 5.7: when `true`, every `` !`cmd` `` block inside a rendered skill
     * body is replaced with `[shell command execution disabled by policy]`
     * instead of running. Mirrors Claude Code's `disableSkillShellExecution`
     * settings flag. Defaults to `false`.
     */
    disableSkillShellExecution?: boolean;
    /**
     * Phase 5.7: environment values exposed to the skill substitution helper
     * via the generic `${VAR}` passthrough. Keep this NARROW — passing the full
     * `process.env` would leak host env vars into the rendered body. Defaults
     * to `{}` (only the well-known `CLAUDE_*` keys resolve).
     */
    skillEnv?: Readonly<Record<string, string>>;
    /**
     * Phase 5.8: pre-resolved plugin contributions to fold into the run. Each
     * {@link LoadedPlugin} contributes:
     *
     * - Skill discovery roots — appended to the {@link skills} loader's plugin
     *   roots (namespaced `<pluginName>:<skillName>`).
     * - MCP server entries — appended to the resolved {@link mcpServers} list
     *   (namespaced `<pluginName>:<serverName>`).
     * - Hook configs — exposed verbatim on the plugin loader output. v1 does
     *   NOT execute plugin hook commands; runtime hook command execution is a
     *   v2 deferral. Hosts that need it can read `LoadedPlugin.hookConfigs`
     *   and wire their own dispatch.
     *
     * `PluginStart` / `PluginStop` lifecycle hooks bracket the run for every
     * entry in this array (always 1:1 paired). Auto-discovery from user /
     * project scope is NOT performed by the agent — callers use
     * {@link loadPlugins} to resolve their own list.
     *
     * Ignored when neither {@link skills} nor {@link skillsDir} is set AND
     * {@link mcpServers} is explicitly set (plugins contribute through both
     * channels; the lifecycle hook still fires for audit). Defaults to an
     * empty array.
     */
    plugins?: readonly LoadedPlugin[];
}
/**
 * Single-shot async iterable that drives an OpenRouter agent turn-by-turn and
 * yields normalized {@link AgentCoreEvent}s. One instance per query. Construct,
 * `for await` the events, done.
 */
export declare class OpenRouterAgentRun implements AsyncIterable<AgentCoreEvent> {
    #private;
    private readonly opts;
    private readonly internalAbortController;
    private readonly compositeSignal;
    /** True when caller supplied a custom `tools` array (signal not auto-wrapped). */
    private readonly hasCustomTools;
    /**
     * Shared task list both `task_create` / `task_update` factories mutate.
     * Ephemeral per run — never persisted to `state.json`. Survives across
     * turns inside this run instance.
     */
    private readonly taskListRef;
    /**
     * Snapshot of `persistSession` captured at construction. Used by
     * {@link fork} to short-circuit the in-memory rejection path without
     * touching the filesystem (and without exposing the full resolved-opts
     * struct on the instance).
     */
    private readonly persistSession;
    /**
     * Phase 5.1: state accessor created once at construction so the public
     * {@link compact} method can read/write the persisted
     * {@link ConversationState} without depending on whether {@link iterate}
     * has been driven yet. File-backed when `persistSession !== false`,
     * otherwise an in-memory mirror sharing the same load/save contract.
     */
    private readonly stateAccessor;
    private consumed;
    constructor(options: OpenRouterAgentRunOptions);
    /**
     * Phase 5.3: imperatively queue a follow-up user message. Resolves
     * immediately — the queue is just a buffer (unbounded), and the message is
     * picked up between turns of the multi-turn restart loop after any
     * already-pending input drains.
     *
     * Pull order each between-turn iteration:
     * 1. Imperative queue (FIFO; this is where `pushUserMessage` lands).
     * 2. Constructor-supplied `AsyncIterable<UserInput>` (if any). If both are
     *    set, the queue is drained first; the iterable supplies fall-through
     *    input.
     *
     * **Combined with `prompt: string`.** The constructor string is processed
     * first as the run's initial turn; queued messages drive subsequent turns.
     * After the queue empties (and no iterable is wired), the run terminates.
     *
     * **Combined with `prompt: AsyncIterable<UserInput>`.** Queue drains before
     * the iterable is pulled, so pushed messages take precedence over the
     * iterable's pacing. Pushing while a `for await (... of iter)` is awaiting
     * does NOT preempt the in-flight pull — the value is buffered for the
     * FOLLOWING pull.
     *
     * Returns a resolved Promise (the async signature is for symmetry / future
     * back-pressure; today there is no waiting). Calling after the run
     * terminates is harmless — the value lands in the buffer but is never
     * consumed.
     */
    pushUserMessage(msg: UserInput | string): Promise<void>;
    /**
     * Phase 5.3: request a clean between-turn interruption of the in-flight
     * `callModel`. Writes `state.interruptedBy = 'host-interrupt'` via the
     * run's {@link StateAccessor}; the SDK's `checkForInterruption` polling
     * observes the flag on its next iteration and exits the call with
     * `status: 'interrupted'` and `partialResponse` populated (the in-flight
     * assistant text is captured server-side under that field).
     *
     * The returned Promise resolves when the current `callModel` cycle has
     * finished unwinding (or immediately when no cycle is in flight). The
     * outer streaming-input loop then commits the partial assistant text into
     * the conversation history (so the model has a faithful transcript) and
     * pulls the next message from the queue / iterable. If no further input
     * is available, the run ends cleanly with `stream_complete.status:
     * 'success'` and `reason: 'host-interrupt'`.
     *
     * **Idempotent.** Calling before iteration starts buffers the flag — the
     * first `callModel` will load state and observe the flag immediately,
     * exiting after one short cycle. Calling after the run terminates is a
     * harmless write that is never consumed.
     *
     * **Granularity.** The SDK only polls the interrupt flag between turns
     * (and between SSE event batches), not inside a single token stream. A
     * long single-response generation cannot be cut mid-token — interrupt
     * lands at the next turn boundary. This matches the Claude SDK's coarser
     * "between turns" behaviour for non-Anthropic backends.
     */
    interrupt(): Promise<void>;
    /**
     * Build a fresh OpenRouter client with the run's apiKey / baseUrl /
     * appTitle. Used by both the main {@link iterate} loop and the public
     * {@link compact} method — compaction needs its own short-lived client
     * because it may be called outside an active iteration.
     */
    private createOpenRouterClient;
    /**
     * Invoke the run's `onHook` handler with the given event/payload, returning
     * the handler's raw return value (or `undefined` when no handler is set or
     * the handler throws). Throws are logged via {@link AgentLogger} and
     * swallowed — never re-raised — so a handler cannot break the run. Used
     * by both {@link iterate} (via a thin local closure that forwards into
     * here) and {@link compact} (directly).
     */
    private safeFireHook;
    /**
     * Phase 5.1: condense the older portion of this run's persisted message
     * history into a single `developer`-role summary message, replacing the
     * prefix on disk. Loads {@link ConversationState} via the run's
     * {@link StateAccessor}, fires the {@link HookEvent} `PreCompact` audit
     * hook with the slice about to be summarized, spawns an isolated
     * single-shot `callModel` (session id `<sessionId>:compact:<uuid>`, no
     * tools) to produce the summary text, then writes back a new
     * `ConversationState` where:
     *
     * - `messages` is `[summary, ...lastKeepRecentTurns]`
     * - `previousResponseId` is cleared (the server cannot splice a stale
     *   response chain onto a rewritten message array; see spike 5.S1 §2d).
     * - In-flight bookkeeping fields (`pendingToolCalls`,
     *   `unsentToolResults`, `partialResponse`) are cleared.
     *
     * No-ops (resolved promise, no hook fired, no state mutation) when the
     * accessor has no saved state, when `messages` is empty, or when the
     * history is shorter than {@link OpenRouterAgentRunOptions.keepRecentTurns}.
     *
     * **Contract — mid-run safety.** Designed to be called between runs that
     * share a `sessionId`, NOT mid-`for await`. The run iterator is
     * single-shot and the SDK manages the in-memory `ConversationState` while
     * a stream is active; calling `compact()` while {@link iterate} is still
     * yielding will race with the SDK's own `state.save()` calls and may
     * corrupt the persisted JSON. Guarded at runtime: calling from outside
     * while iteration is in flight throws synchronously. Auto-compaction
     * (`autoCompact: true`) fires inside {@link iterate}'s `finally` block —
     * after the SDK has finished writing and regardless of whether the
     * consumer drained to end-of-stream or `break`ed early on `stream_complete`.
     *
     * Audit-only failures (PreCompact hook throw) are swallowed via the
     * existing {@link safeFireHook} convention. A failed summarizer call
     * leaves the original state untouched and re-throws so the caller can
     * decide how to recover.
     */
    compact(reason?: 'auto' | 'manual'): Promise<void>;
    /**
     * Decide whether the persisted message history has crossed the
     * auto-compaction threshold. Two accounting modes share one serialization
     * (see {@link serializeMessagesForEstimate} — both paths measure exactly
     * the same string):
     *
     * - **Token mode** — when {@link OpenRouterAgentRunOptions.tokenCounter}
     *   is set, the counter's output is compared against a TOKEN threshold:
     *   `compactionThreshold` verbatim when configured (reinterpreted as
     *   tokens), else `floor(getModelContextWindow(model, modelContextWindows)
     *   * DEFAULT_THRESHOLD_RATIO)`. A throwing counter logs a `'warn'` and
     *   falls through to char mode for this check — a tokenizer bug must
     *   never kill a run that was otherwise healthy.
     * - **Char mode** (default) — serialized length vs.
     *   {@link resolveCompactionThresholdChars} (the v1 chars/4 heuristic),
     *   with the same per-run {@link OpenRouterAgentRunOptions.modelContextWindows}
     *   overrides applied to the window lookup.
     */
    private isOverCompactionThreshold;
    /**
     * Abort the in-flight run. Fires the run's internal AbortController, which
     * triggers cancellation of the OR stream and any in-flight tool execution.
     * Idempotent — safe to call multiple times. Calling before the iterator is
     * consumed causes the first yielded event to be a `stream_complete` with
     * `reason: 'aborted'` (no `session_started`).
     */
    abort(): void;
    [Symbol.asyncIterator](): AsyncIterator<AgentCoreEvent>;
    /**
     * Aggregated message-level view of the run. Drains the underlying
     * {@link AgentCoreEvent} stream and yields typed
     * {@link AgentMessage}s — `SystemMessage(session_start)` → per-turn
     * `AssistantMessage` / `UserMessage` → `ResultMessage` →
     * `SystemMessage(session_end)`.
     *
     * **One consumer per run.** A single {@link OpenRouterAgentRun} instance is
     * single-shot; iterating it via `for await (... of run)` AND via
     * `run.messages()` is unsupported (the second call throws). Pick whichever
     * view you need — the message stream is an opt-in alternative, not a
     * supplement, to the raw event stream.
     *
     * See {@link aggregateMessages} for the precise event → message rules.
     */
    messages(): AsyncIterable<AgentMessage>;
    /**
     * Fork this run's session — copy the on-disk `state.json` to a new session
     * directory under the same `logsRoot`, and stamp a fresh `session.json` with
     * `parentSessionId` set to this run's session id. Convenience wrapper around
     * {@link forkSession} that reuses the run's already-resolved `logsRoot`.
     *
     * Rejects with the documented in-memory error when this run was constructed
     * with `persistSession: false` — there is no `state.json` to copy. The check
     * is local (no FS touch), so callers don't pay an I/O round-trip just to
     * learn the run was ephemeral.
     *
     * Note: forking after construction but before iteration is technically legal
     * — it will reject with the in-memory error path because no `state.json`
     * has been written yet, regardless of `persistSession`. The intended call
     * site is post-iteration, once the run has persisted at least one turn.
     */
    fork(opts?: {
        newSessionId?: string;
    }): Promise<ForkSessionResult>;
    /**
     * Phase 5.2.4 / 5.8: resolve the MCP server list for this run. Precedence:
     *
     * 1. Explicit `mcpServers` ctor option (verbatim, including empty array).
     * 2. When `autoDiscoverMcp: true`, walk `cwd` + user scope via
     *    {@link loadMcpConfig}. Discovery failures are caught and logged —
     *    a malformed `.mcp.json` does not crash the run.
     * 3. Otherwise an empty array (no MCP servers spawned).
     *
     * Phase 5.8: plugin-contributed MCP servers are appended AFTER the
     * base resolution. They are already namespaced `<pluginName>:<serverName>`
     * by the plugin loader so collisions with user/project servers are
     * impossible.
     */
    private resolveMcpServers;
    private iterate;
}
//# sourceMappingURL=agent.d.ts.map