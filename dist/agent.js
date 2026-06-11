import { OpenRouter, stepCountIs, maxCost, isTurnStartEvent, isTurnEndEvent, isToolCallOutputEvent, isClientTool, } from '@openrouter/agent';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { COMPACTION_PROMPT, DEFAULT_KEEP_RECENT_TURNS, partitionMessages, resolveCompactionThresholdChars, resolveCompactionThresholdTokens, serializeMessagesForEstimate, } from './compaction.js';
import { StreamStallError, createStallMonitor, monitorStream } from './stall.js';
import { allTools } from './tools/index.js';
import { createSkillLoader, } from './skills/index.js';
import { DEFAULT_SKILL_DESCRIPTION_BUDGET, buildSkillListing, } from './tools/skill.js';
import { createServerToolsHooks } from './tools/server-tools.js';
import { isServerToolOutputItem, normalizeServerToolItem } from './tools/server-tool-items.js';
import { createFileStateAccessor } from './state/file-state.js';
import { createMemoryStateAccessor } from './state/memory-state.js';
import { createRequestId, createGenerationId, logRequest, logGeneration, logSessionStart, } from './logging/logger.js';
import { logTranscriptSessionStart, logTranscriptUser, logTranscriptAssistant, logTranscriptToolResult, logTranscriptServerTool, logTranscriptCompact, logTranscriptSessionEnd, } from './logging/transcript.js';
import { permissionModeToCanUseTool } from './permission-modes.js';
import { buildToolFilterCanUseTool, compileRule } from './tool-filters.js';
import { composeInstructions } from './context-discovery.js';
import { aggregateMessages } from './messages.js';
import { forkSession } from './session-fork.js';
import { DEFAULT_MAX_SUBAGENT_DEPTH, DEFAULT_MAX_PARALLEL_SUBAGENTS, } from './tools/spawn-subagent.js';
import { McpBridge, MCP_TOOL_NAME_SEPARATOR } from './mcp/bridge.js';
import { loadMcpConfig } from './mcp/config.js';
import { StreamingInputSource, commitPartialResponse, isAsyncIterable, setInterruptedFlag, userInputToCallModelItem, } from './streaming-input.js';
const DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_BUDGET_USD = 1.0;
const DEFAULT_APP_TITLE = 'openrouter-agent-harness';
const ABORT_REASON = 'aborted';
/**
 * Default number of automatic retries for a callModel cycle that died with a
 * transient terminal failure (see {@link OpenRouterAgentRunOptions.maxTransientRetries}).
 * Two retries + the initial attempt rides out the single-shot upstream 500s
 * observed in production (2026-06-10 incident: exact replays of the failing
 * payloads succeeded immediately after the incident window).
 */
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
/**
 * Default base delay for the exponential backoff between transient-failure
 * retries: attempt N sleeps `base * 2^N` ms (500ms, 1s, 2s, …).
 */
const DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS = 500;
/**
 * Default hung-stream threshold (see
 * {@link OpenRouterAgentRunOptions.streamStallTimeoutMs}). Two minutes of
 * total SSE silence with no client tool in flight comfortably exceeds any
 * legitimate inter-token gap observed in production (provider thinking
 * pauses run seconds, not minutes) while still bounding the worst-case
 * hang of a dead upstream connection.
 */
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 120_000;
/**
 * Default per-tool execute deadline (see
 * {@link OpenRouterAgentRunOptions.toolTimeoutMs}). One minute covers every
 * non-exempt built-in (file I/O, grep/glob, notebook edits) with a wide
 * margin; the long-running tools — `bash` (own `timeout_ms`),
 * `spawn_subagent`/`spawn_subagents`, `ask_user_question` (blocks on a
 * human), `monitor` (waits on a condition by design), `skill` (fork-context
 * skills run a whole subagent inside execute), MCP-bridged tools — are
 * exempt.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/**
 * Default system instructions for the built-in code-editing agent. Exported so
 * library consumers can extend, prefix, or replace the string without
 * re-deriving it from source.
 */
export const DEFAULT_INSTRUCTIONS = 'You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.';
function resolveOptions(opts) {
    if (!opts.apiKey) {
        throw new Error('apiKey is required');
    }
    const cwd = opts.cwd ?? process.cwd();
    // Resolve the canUseTool gate in this precedence order:
    //   1. explicit canUseTool — wins outright; permissionMode + allowed/disallowed lists are ignored.
    //   2. allowedTools / disallowedTools — composed via buildToolFilterCanUseTool, with
    //      permissionMode (if set) supplied as the fallback gate.
    //   3. permissionMode alone — translated to a CanUseTool via permissionModeToCanUseTool.
    //   4. nothing — undefined gate, every tool runs (back-compat default).
    // When the explicit canUseTool collides with either of the higher-level
    // options, a single warn log mentioning all three names fires so the
    // conflict is visible to whoever is reading the log.
    const filterListsSet = opts.allowedTools !== undefined || opts.disallowedTools !== undefined;
    const sources = [];
    if (opts.canUseTool !== undefined)
        sources.push('canUseTool');
    if (opts.permissionMode !== undefined)
        sources.push('permissionMode');
    if (filterListsSet)
        sources.push('allowedTools/disallowedTools');
    let canUseTool;
    if (opts.canUseTool !== undefined) {
        canUseTool = opts.canUseTool;
        if (sources.length > 1) {
            opts.logger?.('warn', 'Explicit canUseTool was supplied alongside higher-level permission options (permissionMode, allowedTools/disallowedTools); canUseTool wins and the others are ignored', { permissionMode: opts.permissionMode, sources });
        }
    }
    else if (filterListsSet) {
        const modeGate = opts.permissionMode !== undefined
            ? permissionModeToCanUseTool(opts.permissionMode)
            : undefined;
        canUseTool = buildToolFilterCanUseTool({
            allowedTools: opts.allowedTools,
            disallowedTools: opts.disallowedTools,
            modeGate,
        });
    }
    else if (opts.permissionMode !== undefined) {
        canUseTool = permissionModeToCanUseTool(opts.permissionMode);
    }
    const plugins = opts.plugins ?? [];
    const skills = resolveSkillLoader(opts, cwd, plugins);
    return {
        apiKey: opts.apiKey,
        sessionId: opts.sessionId,
        prompt: opts.prompt,
        instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
        model: opts.model ?? DEFAULT_MODEL,
        cwd,
        maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
        maxTransientRetries: opts.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES,
        transientRetryBaseDelayMs: opts.transientRetryBaseDelayMs ?? DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS,
        streamStallTimeoutMs: opts.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS,
        toolTimeoutMs: opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        tools: opts.tools ?? [],
        appTitle: opts.appTitle ?? DEFAULT_APP_TITLE,
        logsRoot: opts.logsRoot ?? join(cwd, 'logs'),
        canUseTool,
        onHook: opts.onHook,
        onAskUserQuestion: opts.onAskUserQuestion,
        onTasksChanged: opts.onTasksChanged,
        signal: opts.signal,
        baseUrl: opts.baseUrl,
        logger: opts.logger,
        settingSources: opts.settingSources ?? [],
        persistSession: opts.persistSession ?? true,
        checkpoint: opts.checkpoint ?? false,
        parentSessionId: opts.parentSessionId,
        enableSubagents: opts.enableSubagents ?? false,
        maxSubagentDepth: opts.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
        currentSubagentDepth: opts.currentSubagentDepth ?? 0,
        maxParallelSubagents: opts.maxParallelSubagents ?? DEFAULT_MAX_PARALLEL_SUBAGENTS,
        ...(opts.permissionMode !== undefined && { permissionMode: opts.permissionMode }),
        ...(opts.allowedTools !== undefined && { allowedTools: opts.allowedTools }),
        ...(opts.disallowedTools !== undefined && { disallowedTools: opts.disallowedTools }),
        ...(opts.effort !== undefined && { effort: opts.effort }),
        ...(opts.cacheControl !== undefined && { cacheControl: opts.cacheControl }),
        ...(opts.disableServerTools !== undefined && { disableServerTools: opts.disableServerTools }),
        ...(opts.compactionThreshold !== undefined && {
            compactionThreshold: opts.compactionThreshold,
        }),
        ...(opts.modelContextWindows !== undefined && {
            modelContextWindows: opts.modelContextWindows,
        }),
        ...(opts.tokenCounter !== undefined && { tokenCounter: opts.tokenCounter }),
        keepRecentTurns: opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
        autoCompact: opts.autoCompact ?? true,
        ...(opts.mcpServers !== undefined && { mcpServers: opts.mcpServers }),
        autoDiscoverMcp: opts.autoDiscoverMcp ?? false,
        enableToolSearch: opts.enableToolSearch ?? false,
        ...(skills !== undefined && { skills }),
        skillDescriptionBudget: opts.skillDescriptionBudget ?? DEFAULT_SKILL_DESCRIPTION_BUDGET,
        disableSkillShellExecution: opts.disableSkillShellExecution ?? false,
        skillEnv: opts.skillEnv ?? {},
        plugins,
    };
}
/**
 * Resolve the skill loader from the constructor options.
 *
 * - Explicit `skills` wins (caller is responsible for any plugin pluginRoots
 *   wiring on their own loader; a `'warn'`-level log fires when plugins are
 *   supplied alongside a pre-built skills loader to flag the silent skip).
 * - Otherwise: when `skillsDir` is set OR `plugins` is non-empty, construct a
 *   default loader. Plugin skill roots are folded in as namespaced
 *   {@link SkillLoaderOptions.pluginRoots}.
 * - Otherwise returns `undefined` (no skill wiring happens).
 */
function resolveSkillLoader(opts, cwd, plugins) {
    if (opts.skills !== undefined) {
        if (plugins.length > 0) {
            opts.logger?.('warn', 'plugins supplied alongside a pre-built skills loader — plugin skill roots will not be auto-wired; pass the plugin pluginRoots into the loader yourself', { pluginCount: plugins.length });
        }
        return opts.skills;
    }
    if (opts.skillsDir !== undefined || plugins.length > 0) {
        const pluginRoots = [];
        for (const plugin of plugins) {
            for (const skillsDir of plugin.skillRoots) {
                pluginRoots.push({ name: plugin.manifest.name, root: plugin.root, skillsDir });
            }
        }
        return createSkillLoader({
            cwd: opts.skillsDir ?? cwd,
            ...(opts.logger && { logger: opts.logger }),
            ...(pluginRoots.length > 0 && { pluginRoots }),
        });
    }
    return undefined;
}
/**
 * Single-shot async iterable that drives an OpenRouter agent turn-by-turn and
 * yields normalized {@link AgentCoreEvent}s. One instance per query. Construct,
 * `for await` the events, done.
 */
export class OpenRouterAgentRun {
    opts;
    internalAbortController = new AbortController();
    compositeSignal;
    /** True when caller supplied a custom `tools` array (signal not auto-wrapped). */
    hasCustomTools;
    /**
     * Shared task list both `task_create` / `task_update` factories mutate.
     * Ephemeral per run — never persisted to `state.json`. Survives across
     * turns inside this run instance.
     */
    taskListRef = { tasks: [] };
    /**
     * Snapshot of `persistSession` captured at construction. Used by
     * {@link fork} to short-circuit the in-memory rejection path without
     * touching the filesystem (and without exposing the full resolved-opts
     * struct on the instance).
     */
    persistSession;
    /**
     * Phase 5.1: state accessor created once at construction so the public
     * {@link compact} method can read/write the persisted
     * {@link ConversationState} without depending on whether {@link iterate}
     * has been driven yet. File-backed when `persistSession !== false`,
     * otherwise an in-memory mirror sharing the same load/save contract.
     */
    stateAccessor;
    consumed = false;
    /**
     * Phase 5.1: runtime guard against calling {@link compact} while
     * {@link iterate} is mid-stream. Set to true at the top of iterate(),
     * cleared in its finally block BEFORE the auto-compact trigger so the
     * auto-trigger does not race against its own guard.
     */
    #isIterating = false;
    /**
     * Phase 5.2.4: per-run MCP server pool. Lazily constructed at the top of
     * {@link iterate} (after the `Setup` hook fires) and torn down in the
     * `finally` block. `undefined` until init runs; remains `undefined` when
     * the run has no MCP servers configured (or discovery yields none).
     */
    #mcpBridge;
    /**
     * Phase 5.3: streaming-input source — wraps the constructor `prompt`
     * (`string | AsyncIterable<UserInput>`) and the imperative
     * {@link pushUserMessage} queue behind a single `next()` interface that the
     * multi-turn restart loop drains. Constructed eagerly so
     * {@link pushUserMessage} works from the moment the run object exists
     * (callers commonly wire a UI listener that pushes before/during the
     * `for await` consumer loop).
     */
    #inputSource;
    /**
     * Phase 5.3: resolves when the currently-in-flight `callModel` cycle's
     * for-await stream loop completes (or rejects). Set at the top of each
     * cycle and cleared in its finally block. {@link interrupt} awaits this
     * promise so the host has a clean "stopped before next turn" handle.
     *
     * `undefined` outside a cycle (idle, between cycles, or after end-of-iter)
     * — in which case `interrupt()` is a no-op beyond the idempotent state
     * write that buffers the flag for the next cycle (if any).
     */
    #currentCycle;
    constructor(options) {
        this.opts = resolveOptions(options);
        this.hasCustomTools = options.tools !== undefined;
        this.persistSession = this.opts.persistSession;
        this.compositeSignal = options.signal
            ? AbortSignal.any([this.internalAbortController.signal, options.signal])
            : this.internalAbortController.signal;
        this.stateAccessor = this.persistSession
            ? createFileStateAccessor(this.opts.logsRoot, this.opts.sessionId)
            : createMemoryStateAccessor();
        // Validate the prompt shape eagerly so a caller passing the wrong type
        // gets a synchronous error at construction (not a deferred crash inside
        // the iterator). Accepted: `string` or any value with `Symbol.asyncIterator`.
        if (typeof options.prompt !== 'string' && !isAsyncIterable(options.prompt)) {
            throw new Error('prompt must be a string or an AsyncIterable<UserInput> (Phase 5.3 streaming input).');
        }
        this.#inputSource = new StreamingInputSource(this.opts.prompt);
    }
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
    pushUserMessage(msg) {
        this.#inputSource.push(msg);
        return Promise.resolve();
    }
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
    async interrupt() {
        await setInterruptedFlag(this.stateAccessor, 'host-interrupt');
        if (this.#currentCycle) {
            try {
                await this.#currentCycle;
            }
            catch {
                // A throw on the cycle promise is the consumer's problem to see via
                // their `for await` — we don't surface it here. interrupt() succeeds
                // as soon as the cycle has unwound, regardless of how.
            }
        }
    }
    /**
     * Build a fresh OpenRouter client with the run's apiKey / baseUrl /
     * appTitle. Used by both the main {@link iterate} loop and the public
     * {@link compact} method — compaction needs its own short-lived client
     * because it may be called outside an active iteration.
     */
    createOpenRouterClient() {
        return new OpenRouter({
            apiKey: this.opts.apiKey,
            ...(this.opts.baseUrl && { serverURL: this.opts.baseUrl }),
            appTitle: this.opts.appTitle,
            ...(this.opts.disableServerTools !== true && { hooks: createServerToolsHooks() }),
        });
    }
    /**
     * Invoke the run's `onHook` handler with the given event/payload, returning
     * the handler's raw return value (or `undefined` when no handler is set or
     * the handler throws). Throws are logged via {@link AgentLogger} and
     * swallowed — never re-raised — so a handler cannot break the run. Used
     * by both {@link iterate} (via a thin local closure that forwards into
     * here) and {@link compact} (directly).
     */
    async safeFireHook(event, payload) {
        const { onHook, logger } = this.opts;
        if (!onHook)
            return undefined;
        try {
            return await onHook(event, payload);
        }
        catch (err) {
            logger?.('error', 'Hook threw', { event, error: err });
            return undefined;
        }
    }
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
    async compact(reason = 'manual') {
        if (this.#isIterating) {
            throw new Error('Cannot call compact() while iterate() is in progress — see the Mid-run safety note in the README.');
        }
        const state = await this.stateAccessor.load();
        if (!state)
            return;
        const rawMessages = state.messages;
        if (!Array.isArray(rawMessages) || rawMessages.length === 0)
            return;
        const { summarize, keep } = partitionMessages(rawMessages, this.opts.keepRecentTurns);
        if (summarize.length === 0)
            return;
        await this.safeFireHook('PreCompact', {
            event: 'PreCompact',
            messages: summarize,
            keepRecentTurns: this.opts.keepRecentTurns,
            reason,
        });
        const client = this.createOpenRouterClient();
        const compactSessionId = `${this.opts.sessionId}:compact:${randomUUID()}`;
        const result = client.callModel({
            model: this.opts.model,
            sessionId: compactSessionId,
            input: JSON.stringify(summarize),
            instructions: COMPACTION_PROMPT,
            // Compaction prompts are exactly the kind of large reusable prefix that
            // benefits from auto prompt caching. Inherit the run's `cacheControl`
            // when set; omit when unset (preserves prior behavior).
            ...(this.opts.cacheControl !== undefined && {
                cacheControl: this.opts.cacheControl,
            }),
        });
        let summaryText = '';
        for await (const event of result.getFullResponsesStream()) {
            if (typeof event === 'object' &&
                event !== null &&
                'type' in event &&
                event.type === 'response.output_text.delta') {
                const delta = event.delta;
                if (typeof delta === 'string')
                    summaryText += delta;
            }
        }
        const summaryMessage = {
            type: 'message',
            role: 'developer',
            content: `[Compacted prior context]\n${summaryText}`,
        };
        const nextState = {
            ...state,
            messages: [summaryMessage, ...keep],
            updatedAt: Date.now(),
        };
        // The SDK uses `undefined` to mean "absent" for these optional fields;
        // deleting them keeps the on-disk JSON tidy and lets a re-load via the
        // accessor yield the same shape the SDK would build from scratch.
        delete nextState.previousResponseId;
        delete nextState.pendingToolCalls;
        delete nextState.unsentToolResults;
        delete nextState.partialResponse;
        await this.stateAccessor.save(nextState);
        if (this.persistSession) {
            await logTranscriptCompact({
                logsRoot: this.opts.logsRoot,
                sessionId: this.opts.sessionId,
                reason,
                droppedMessages: summarize.length,
                summaryText,
            });
        }
    }
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
    isOverCompactionThreshold(messages) {
        const { tokenCounter, compactionThreshold, model, modelContextWindows, logger } = this.opts;
        const serialized = serializeMessagesForEstimate(messages);
        if (tokenCounter !== undefined) {
            try {
                const tokens = tokenCounter(serialized);
                const thresholdTokens = resolveCompactionThresholdTokens(compactionThreshold, model, modelContextWindows);
                return tokens >= thresholdTokens;
            }
            catch (err) {
                logger?.('warn', 'tokenCounter threw — falling back to the chars/4 heuristic', {
                    error: err,
                });
            }
        }
        const thresholdChars = resolveCompactionThresholdChars(compactionThreshold, model, modelContextWindows);
        return serialized.length >= thresholdChars;
    }
    /**
     * Abort the in-flight run. Fires the run's internal AbortController, which
     * triggers cancellation of the OR stream and any in-flight tool execution.
     * Idempotent — safe to call multiple times. Calling before the iterator is
     * consumed causes the first yielded event to be a `stream_complete` with
     * `reason: 'aborted'` (no `session_started`).
     */
    abort() {
        if (!this.internalAbortController.signal.aborted) {
            this.internalAbortController.abort();
        }
    }
    [Symbol.asyncIterator]() {
        if (this.consumed) {
            throw new Error('OpenRouterAgentRun is single-shot and has already been consumed');
        }
        this.consumed = true;
        return this.iterate();
    }
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
    messages() {
        return aggregateMessages(this, this.opts.sessionId);
    }
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
    fork(opts = {}) {
        if (!this.persistSession) {
            return Promise.reject(new Error(`cannot fork in-memory session: ${this.opts.sessionId} has no on-disk state at ${join(this.opts.logsRoot, this.opts.sessionId, 'state.json')}`));
        }
        return forkSession({
            sessionId: this.opts.sessionId,
            logsRoot: this.opts.logsRoot,
            ...(opts.newSessionId !== undefined && { newSessionId: opts.newSessionId }),
        });
    }
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
    async resolveMcpServers() {
        let base;
        if (this.opts.mcpServers !== undefined) {
            base = this.opts.mcpServers;
        }
        else if (!this.opts.autoDiscoverMcp) {
            base = [];
        }
        else {
            try {
                base = await loadMcpConfig({ cwd: this.opts.cwd });
            }
            catch (err) {
                this.opts.logger?.('warn', 'MCP discovery failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                base = [];
            }
        }
        if (this.opts.plugins.length === 0)
            return base;
        const fromPlugins = this.opts.plugins.flatMap((p) => p.mcpServers);
        return [...base, ...fromPlugins];
    }
    async *iterate() {
        const { apiKey, sessionId, instructions: baseInstructions, model, cwd, maxTurns, maxBudgetUsd, maxTransientRetries, transientRetryBaseDelayMs, tools: userTools, appTitle, logsRoot, baseUrl, logger, onHook, settingSources, persistSession, onAskUserQuestion, onTasksChanged, parentSessionId, } = this.opts;
        // Discovery happens here (not in resolveOptions) so the constructor stays
        // synchronous and the public API shape is unchanged. When settingSources
        // is empty, composeInstructions short-circuits without any FS reads.
        const composedInstructions = settingSources.length > 0
            ? await composeInstructions({ cwd, settingSources, instructions: baseInstructions, logger })
            : baseInstructions;
        // Phase 5.7: discover skills (if a loader is configured) and append a
        // `## Available Skills` block to the instructions within the configured
        // budget. Skills dropped from the listing remain callable by exact name.
        const skillsForRun = this.opts.skills ? await this.opts.skills.list() : [];
        const skillVisibleNames = [];
        let instructions = composedInstructions;
        if (skillsForRun.length > 0) {
            const budgetChars = Math.max(128, Math.floor(this.opts.skillDescriptionBudget * 200_000));
            const listing = buildSkillListing(skillsForRun, budgetChars);
            if (listing.length > 0) {
                instructions = `${composedInstructions}\n\n${listing}`;
                // Parse visible names back out of the listing block so the skill
                // tool's description can mirror them. The listing entries are lines
                // starting with `- \``. This avoids passing the buildSkillListing
                // result back as a structured object and keeps the data flow simple.
                for (const line of listing.split('\n')) {
                    const m = /^-\s+`([^`]+)`/.exec(line);
                    if (m && m[1] !== undefined)
                        skillVisibleNames.push(m[1]);
                }
            }
            else {
                // Listing was empty (every skill had disable-model-invocation or the
                // budget was tighter than the smallest entry). Keep skillsForRun
                // around so the tool can still be invoked by exact name.
            }
        }
        const startMs = Date.now();
        let maxTurnNumber = 0;
        let totalCostUsd = 0;
        let finalUsage = null;
        // Tool call_id → tool_name, populated when the SDK emits a function_call
        // item and read when the matching tool_call_output arrives. The output
        // event carries only the callId, so a side-map is the cheapest way to
        // surface the human-readable name on the transcript record.
        const toolCallNames = new Map();
        // Set true once the session_start transcript record lands. Errors thrown
        // before that point (bad logsRoot, createOpenRouterClient throws,
        // pre-session_start cwd-related failures) skip the matching session_end
        // transcript write so we never try to write into a directory that
        // doesn't exist.
        let transcriptStarted = false;
        const signal = this.compositeSignal;
        // Captured at every stream_complete yield site so the outer finally can
        // fire exactly one SessionEnd hook with matching status/usage/cost. Null
        // when the run somehow exits without yielding stream_complete (should be
        // unreachable — every path ends in a stream_complete).
        let sessionEndPayload = null;
        // Mirrors sessionEndPayload but for the trailing Stop hook. Stop fires
        // last regardless of completion status; reason is populated on abort or
        // thrown-error paths so subscribers can distinguish clean from dirty exit.
        let stopPayload = { event: 'Stop', status: 'error' };
        // Hoisted so the `finally` block can gate the auto-compact trigger on
        // it. Default 'error' covers any path that exits iterate() without
        // explicitly setting it (pre-abort short-circuit, OR-ctor throw, mid-
        // stream throw, abort). The happy-path arm assigns the result of
        // {@link deriveCompletionStatus}.
        let status = 'error';
        // Captured when a `response.failed` event flows through the SDK
        // broadcaster. We intentionally do NOT throw from inside the for-await
        // loop because that would close the SDK generator (via `iter.return()`)
        // before it reaches its terminal `await executionPromise;` — orphaning
        // the chained promise created by `startTurnBroadcasterExecution`'s
        // `.finally()` and surfacing as an `unhandledRejection` that kills the
        // host process. Holding the event here lets the catch arm convert it to
        // the pretty-printed reason via {@link extractResponseFailedMessage}.
        let pendingFailedEvent = null;
        this.#isIterating = true;
        // Phase 5.8: per-plugin start timestamps so `PluginStop` can report the
        // elapsed lifetime. Populated as each `PluginStart` fires below; drained
        // in the outer `finally`. Empty Map when no plugins are configured.
        const pluginStartTimes = new Map();
        // Phase 5.8: lookup table consumed by the skill tool's `buildContext`
        // closure when an active plugin-sourced skill renders — built once here
        // so the closure body is a single Map.get call. Empty Map when no
        // plugins are configured (the closure short-circuits via the
        // `skill.pluginName` truthy check).
        const pluginByName = new Map(this.opts.plugins.map((p) => [p.manifest.name, p]));
        // Thin forwarder around the class-level safeFireHook so the existing
        // closures in this generator (subagent lifecycle emitters,
        // wrapToolWithHooks plumbing, etc.) keep their original call signature.
        // The class-level method exists so {@link compact} can fire PreCompact
        // outside this generator without duplicating the try/catch.
        const safeFireHook = (event, payload) => this.safeFireHook(event, payload);
        // Setup fires once per OpenRouterAgentRun instance, before any other hook
        // (including SessionStart). It precedes the pre-abort short-circuit and
        // the OR client constructor so abort-at-construction and
        // OR-constructor-throw paths still emit a Setup → ... → Stop bracket.
        await safeFireHook('Setup', { event: 'Setup', sessionId, cwd });
        logger?.('debug', 'OpenRouterAgentRun starting', {
            sessionId,
            model,
            maxTurns,
            maxBudgetUsd,
            cwd,
            logsRoot,
        });
        // Use a holder so the abort listener can fire result.cancel() once the
        // call has been issued. result is undefined briefly before callModel().
        // `getResponse()` is also tracked so unwind paths (abort + catch) can
        // observe the SDK's internal `executeToolsIfNeeded` promise — see the
        // drain comment near each call site for the bug it works around.
        let resultHandle;
        const onAbort = () => {
            if (resultHandle)
                void resultHandle.cancel().catch(() => undefined);
        };
        let abortListenerInstalled = false;
        try {
            // Pre-aborted at construction time → no session_started, no SessionStart
            // hook; jump straight to a terminal stream_complete event. SessionEnd
            // still fires (it bookends stream_complete, not session_started).
            if (signal.aborted) {
                yield {
                    type: 'stream_complete',
                    status: 'error',
                    durationMs: Date.now() - startMs,
                    reason: ABORT_REASON,
                };
                sessionEndPayload = {
                    event: 'SessionEnd',
                    sessionId,
                    status: 'error',
                    usage: null,
                    costUsd: 0,
                };
                stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
                return;
            }
            let client;
            try {
                client = this.createOpenRouterClient();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                yield { type: 'error', message, cause: err };
                yield {
                    type: 'stream_complete',
                    status: 'error',
                    durationMs: Date.now() - startMs,
                    reason: message,
                };
                sessionEndPayload = {
                    event: 'SessionEnd',
                    sessionId,
                    status: 'error',
                    usage: null,
                    costUsd: 0,
                };
                stopPayload = { event: 'Stop', status: 'error', reason: message };
                return;
            }
            if (persistSession) {
                await logSessionStart(logsRoot, sessionId, cwd, parentSessionId);
                await logTranscriptSessionStart({ logsRoot, sessionId, cwd, parentSessionId });
                transcriptStarted = true;
            }
            yield {
                type: 'session_started',
                sessionId,
                ...(parentSessionId !== undefined && { parentSessionId }),
            };
            await safeFireHook('SessionStart', { event: 'SessionStart', sessionId, cwd, model });
            // Phase 5.1: the accessor is created in the constructor so {@link compact}
            // can reach the same in-memory cache (when `persistSession: false`) or
            // the same on-disk path (when persisted) without duplicating
            // construction. Captured here only to satisfy the local `state` name
            // the SDK passes through.
            const state = this.stateAccessor;
            // Note: server-side tools (datetime/web_search/web_fetch) are injected
            // via OR SDK hooks and execute on OpenRouter's servers — they bypass this
            // wrapper, so canUseTool only ever sees client tools.
            // ctx.notify is injected at tool-execute time by wrapToolWithHooks (so
            // both built-in and custom tools receive it via the SDK ToolExecuteContext
            // they get at call time), not here at factory time. Built-in tool
            // factories close over this ctx for cwd/signal only.
            const ctx = {
                cwd,
                signal,
                sessionId,
                logsRoot,
                checkpoint: this.opts.checkpoint,
                persistSession,
                ...(logger && { logger }),
            };
            // Subagent runner closure (Phase 4.7). Inherits the parent's
            // `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook`
            // / `model` / `cwd` / `persistSession` and constructs a child
            // OpenRouterAgentRun with a fresh session id, the spawn-supplied
            // prompt + optional overrides, and the composite abort signal the
            // factory built. Builds the child's tool pool itself (with
            // `spawn_subagent` at the next depth for further recursion) and
            // passes it via the `tools` arg — the child run sees
            // `hasCustomTools=true` and skips its own default-bundle path.
            const runSubagent = async (config) => {
                const childCtx = {
                    cwd,
                    signal: config.signal,
                    sessionId: config.sessionId,
                    logsRoot,
                    checkpoint: this.opts.checkpoint,
                    persistSession,
                    ...(logger && { logger }),
                };
                const childTaskListRef = { tasks: [] };
                const childAllTools = allTools(childCtx, {
                    ...(onAskUserQuestion && { onAskUserQuestion }),
                    ...(onTasksChanged && { onTasksChanged }),
                    taskListRef: childTaskListRef,
                    spawnSubagent: {
                        parentSessionId: config.sessionId,
                        currentDepth: config.depth,
                        maxDepth: this.opts.maxSubagentDepth,
                        runSubagent,
                        onSubagentLifecycle: async (event, payload) => {
                            await safeFireHook(event, payload);
                        },
                    },
                    spawnSubagents: {
                        parentSessionId: config.sessionId,
                        currentDepth: config.depth,
                        maxDepth: this.opts.maxSubagentDepth,
                        maxParallel: this.opts.maxParallelSubagents,
                        runSubagent,
                        onSubagentLifecycle: async (event, payload) => {
                            await safeFireHook(event, payload);
                        },
                    },
                });
                const toolNames = config.toolNames;
                const childTools = toolNames !== undefined
                    ? childAllTools.filter((t) => isClientTool(t) && toolNames.includes(t.function.name))
                    : childAllTools;
                // Phase 4.8: per-subagent overrides REPLACE the parent's resolved
                // value (instead of composing). The parent's `permissionMode` /
                // `allowedTools` / `disallowedTools` / `model` / `effort` only flow
                // into the child when the spawn call omits its own override. This
                // mirrors the documented semantics in the `spawn_subagent` Zod
                // schema's doc comment — keep the two in sync if either changes.
                const childModel = config.model ?? this.opts.model;
                const childPermissionMode = config.permissionMode ?? this.opts.permissionMode;
                const childAllowedTools = config.allowedTools ?? this.opts.allowedTools;
                const childDisallowedTools = config.disallowedTools ?? this.opts.disallowedTools;
                const childEffort = config.effort ?? this.opts.effort;
                const childCacheControl = config.cacheControl ?? this.opts.cacheControl;
                const childDisableServerTools = config.disableServerTools ?? this.opts.disableServerTools;
                const child = new OpenRouterAgentRun({
                    apiKey,
                    sessionId: config.sessionId,
                    prompt: config.prompt,
                    instructions: config.instructions ?? baseInstructions,
                    model: childModel,
                    cwd,
                    maxTurns: config.maxTurns ?? maxTurns,
                    maxBudgetUsd: config.maxBudgetUsd ?? maxBudgetUsd,
                    maxTransientRetries,
                    transientRetryBaseDelayMs,
                    // Reliability + compaction-accounting knobs ride the same
                    // inheritance rails as the retry budget above: the parent's
                    // resolved values flow into every child verbatim (no per-spawn
                    // override surface in v1 — the spawn schema stays lean).
                    streamStallTimeoutMs: this.opts.streamStallTimeoutMs,
                    toolTimeoutMs: this.opts.toolTimeoutMs,
                    ...(this.opts.modelContextWindows !== undefined && {
                        modelContextWindows: this.opts.modelContextWindows,
                    }),
                    ...(this.opts.tokenCounter !== undefined && { tokenCounter: this.opts.tokenCounter }),
                    appTitle,
                    logsRoot,
                    persistSession,
                    tools: childTools,
                    signal: config.signal,
                    maxParallelSubagents: this.opts.maxParallelSubagents,
                    ...(baseUrl && { baseUrl }),
                    ...(logger && { logger }),
                    ...(onHook && { onHook }),
                    ...(childPermissionMode !== undefined && { permissionMode: childPermissionMode }),
                    ...(childAllowedTools !== undefined && { allowedTools: childAllowedTools }),
                    ...(childDisallowedTools !== undefined && { disallowedTools: childDisallowedTools }),
                    ...(childEffort !== undefined && { effort: childEffort }),
                    ...(childCacheControl !== undefined && { cacheControl: childCacheControl }),
                    ...(childDisableServerTools !== undefined && {
                        disableServerTools: childDisableServerTools,
                    }),
                });
                let text = '';
                let summary = {
                    status: 'error',
                    text: '',
                    reason: 'subagent produced no stream_complete event',
                };
                for await (const ev of child) {
                    if (ev.type === 'text_delta') {
                        text += ev.content;
                    }
                    else if (ev.type === 'stream_complete') {
                        summary = {
                            status: ev.status,
                            text,
                            ...(ev.usage !== undefined && { usage: ev.usage }),
                            ...(ev.costUsd !== undefined && { costUsd: ev.costUsd }),
                            ...(ev.durationMs !== undefined && { durationMs: ev.durationMs }),
                            ...(ev.reason !== undefined && { reason: ev.reason }),
                        };
                    }
                }
                return summary;
            };
            // Phase 5.2.4: spawn MCP servers AFTER `Setup` fired (above) and BEFORE
            // the first `callModel` — keeps the ctor sync, matches the Phase 4.7
            // subagent-runner closure pattern. Per-server failures are logged +
            // surfaced as `Notification`-hook events by the bridge; the run
            // continues with whatever subset of servers handshook successfully.
            // `close()` fires in the outer `finally` regardless of init outcome.
            //
            // Phase 5.5 reordering note: bridge init moved BEFORE baseTools so the
            // `tool_search` / `tool_load` factories' `getCatalog()` closures and
            // the `onLoad` callback can read live `this.#mcpBridge` state without
            // a forward reference. Behaviour is unchanged when `enableToolSearch`
            // is false (the prior post-baseTools init worked because nothing
            // captured the bridge at base-tool factory time).
            const mcpServersToSpawn = await this.resolveMcpServers();
            if (mcpServersToSpawn.length > 0) {
                this.#mcpBridge = new McpBridge({
                    servers: mcpServersToSpawn,
                    ...(logger && { logger }),
                    notify: (level, message, context) => safeFireHook('Notification', {
                        event: 'Notification',
                        level,
                        message,
                        context,
                    }),
                    onLifecycle: async (event, payload) => {
                        await safeFireHook(event, payload);
                    },
                    signal,
                });
                await this.#mcpBridge.init();
            }
            const bridgeTools = this.#mcpBridge?.tools ?? [];
            // Phase 5.8: fire PluginStart for every loaded plugin AFTER MCP init so
            // hosts auditing the lifecycle see "MCP servers attached, plugins
            // attached, ready to model-loop" in order. Per-plugin counts come
            // straight from the LoadedPlugin aggregate. Start times are captured
            // here so the matching PluginStop in `finally` can report `durationMs`.
            for (const plugin of this.opts.plugins) {
                pluginStartTimes.set(plugin.manifest.name, Date.now());
                await safeFireHook('PluginStart', {
                    event: 'PluginStart',
                    pluginName: plugin.manifest.name,
                    root: plugin.root,
                    contributions: {
                        skills: plugin.skillRoots.length,
                        commands: plugin.commandRoots.length,
                        mcpServers: plugin.mcpServers.length,
                        hooks: plugin.hookConfigs.length,
                    },
                });
            }
            // Phase 5.5: shared state for the `tool_search` / `tool_load` pair.
            // `loadedToolNames` is the per-run working-set; `toolsForRun` is the
            // mutable array passed to `callModel`. When `tool_load` fires, we
            // append the wrapped MCP tool to `toolsForRun` — the OR SDK iterates
            // this array on each subsequent turn build, so newly-loaded tools
            // become visible to the model without needing a fresh `callModel`
            // (per-cycle granularity is preserved as a fallback: even if the SDK
            // snapshots the array, the next cycle still picks the loaded set up
            // because it reads from the same shared reference).
            const loadedToolNames = new Set();
            const toolsForRun = [];
            // Phase 5.7: per-skill active context. When the `skill` tool fires, it
            // installs an {@link ActiveSkillContext} via `setActiveSkill` so the
            // wrapped canUseTool below narrows the run-level permission rules to
            // the skill's `allowed-tools`. Disposed in the skill tool's `finally`.
            let activeSkill;
            const setActiveSkill = (cxt) => {
                activeSkill = cxt;
                return () => {
                    if (activeSkill === cxt)
                        activeSkill = undefined;
                };
            };
            // Compose: when a skill is active AND it declares an allow-list, layer
            // those rules ON TOP of the run-level canUseTool with NARROWING
            // semantics — the skill's `allowed-tools` is the complete set of tools
            // the model may invoke while the skill renders. A tool call not matched
            // by ANY rule in the list is denied here. If the skill list passes the
            // call through (matched or no narrowing in play), the run-level gate
            // still runs and can further deny (run-level deny-wins is preserved).
            const baseCanUseTool = this.opts.canUseTool;
            const composedCanUseTool = baseCanUseTool || skillsForRun.length > 0
                ? async (toolName, input, ctx) => {
                    if (activeSkill?.allowedToolsNarrowing) {
                        const inList = activeSkill.allowedToolsNarrowing.some((rule) => {
                            const compiled = compileRule(rule);
                            return compiled.toolName === toolName && compiled.matches(input);
                        });
                        if (!inList) {
                            return {
                                behavior: 'deny',
                                reason: `tool '${toolName}' not in skill '${activeSkill.name}' allowed-tools`,
                            };
                        }
                    }
                    if (baseCanUseTool)
                        return baseCanUseTool(toolName, input, ctx);
                    return { behavior: 'allow' };
                }
                : undefined;
            // Stall-clock suspension state shared by every wrapped tool and the
            // per-cycle stall monitors. `toolsInFlight` counts client tool executes
            // currently running (any > 0 suspends the stall watchdog — tool runs
            // legitimately silence the SSE stream); `activeStallMonitor` points at
            // the CURRENT cycle attempt's monitor so a tool that settles can reset
            // the stall clock (a tool finishing after its cycle already unwound —
            // e.g. a timed-out execute — sees `undefined` and no-ops).
            let toolsInFlight = 0;
            let activeStallMonitor;
            const toolActivity = {
                begin: () => {
                    toolsInFlight++;
                },
                end: () => {
                    toolsInFlight--;
                    activeStallMonitor?.bump();
                },
            };
            // Order of wraps (innermost → outermost): per-tool timeout deadline
            // around the ctx-bound execute, then the canUseTool gate, then the
            // hook wrapper, then the stall-clock activity tracker. The timeout is
            // innermost so PostToolUse and the tool_result both reflect the
            // timeout error; the hook wrapper
            // sits outside the canUseTool gate so PreToolUse fires before the
            // permission decision (audit always fires, even on deny) and
            // PostToolUse fires after the inner result/error is resolved —
            // including the synth-deny payload from a canUseTool denial. The
            // activity tracker is outermost AND unconditional so the stall clock
            // suspends across the whole pipeline (permission prompts included)
            // regardless of whether canUseTool/onHook are wired.
            const wrapTool = (t) => {
                let wrapped = wrapToolWithTimeout(t, this.opts.toolTimeoutMs);
                if (composedCanUseTool) {
                    wrapped = wrapToolWithPermission(wrapped, composedCanUseTool);
                }
                if (onHook) {
                    wrapped = wrapToolWithHooks(wrapped, safeFireHook, logger);
                }
                return wrapToolWithActivityTracker(wrapped, toolActivity);
            };
            const baseTools = this.hasCustomTools
                ? userTools
                : allTools(ctx, {
                    onAskUserQuestion,
                    onTasksChanged,
                    taskListRef: this.taskListRef,
                    ...(this.opts.enableSubagents && {
                        spawnSubagent: {
                            parentSessionId: sessionId,
                            currentDepth: this.opts.currentSubagentDepth,
                            maxDepth: this.opts.maxSubagentDepth,
                            runSubagent,
                            onSubagentLifecycle: async (event, payload) => {
                                await safeFireHook(event, payload);
                            },
                        },
                        spawnSubagents: {
                            parentSessionId: sessionId,
                            currentDepth: this.opts.currentSubagentDepth,
                            maxDepth: this.opts.maxSubagentDepth,
                            maxParallel: this.opts.maxParallelSubagents,
                            runSubagent,
                            onSubagentLifecycle: async (event, payload) => {
                                await safeFireHook(event, payload);
                            },
                        },
                    }),
                    ...(this.opts.enableToolSearch && {
                        toolSearch: { getCatalog: () => this.#mcpBridge?.catalog ?? [] },
                        toolLoad: {
                            getCatalog: () => this.#mcpBridge?.catalog ?? [],
                            isLoaded: (name) => loadedToolNames.has(name),
                            onLoad: async (name, server) => {
                                // The factory's `isLoaded` guard already short-circuits
                                // already-loaded names before reaching onLoad, and the
                                // `getCatalog` source is the same one the factory checks
                                // for `notFound` — so an entry that passes both gates is
                                // guaranteed to exist in `bridgeTools` (catalog and tools
                                // are derived from the same bridge entries). The `find`
                                // therefore never returns undefined in practice; the
                                // non-null assertion documents that invariant.
                                const found = bridgeTools.find((t) => isClientTool(t) && t.function.name === name);
                                loadedToolNames.add(name);
                                toolsForRun.push(wrapTool(found));
                                await safeFireHook('Notification', {
                                    event: 'Notification',
                                    level: 'info',
                                    message: 'tool_loaded',
                                    context: { name, server },
                                });
                            },
                        },
                    }),
                    ...(this.opts.skills && {
                        skill: {
                            loader: this.opts.skills,
                            visibleNames: skillVisibleNames,
                            buildContext: (args, skill) => {
                                // Phase 5.8: when the active skill came from a plugin,
                                // propagate ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA}
                                // into the substitution context. The plugin lookup uses
                                // the run-level Map built once below for O(1) access.
                                const owningPlugin = skill.pluginName
                                    ? pluginByName.get(skill.pluginName)
                                    : undefined;
                                return {
                                    arguments: args,
                                    sessionId,
                                    projectDir: cwd,
                                    cwd,
                                    env: this.opts.skillEnv,
                                    signal,
                                    disableShellExecution: this.opts.disableSkillShellExecution,
                                    ...(this.opts.effort !== undefined && { effort: this.opts.effort }),
                                    ...(skill.frontmatter.arguments !== undefined && {
                                        named: namedFromPositional(skill.frontmatter.arguments, args),
                                    }),
                                    ...(owningPlugin && {
                                        pluginRoot: owningPlugin.root,
                                        pluginData: owningPlugin.dataDir,
                                    }),
                                };
                            },
                            onSkillLoaded: async (skill) => {
                                await safeFireHook('Notification', {
                                    event: 'Notification',
                                    level: 'info',
                                    message: 'skill_loaded',
                                    context: { name: skill.name, source: skill.source },
                                });
                            },
                            onSkillActive: setActiveSkill,
                            ...(this.opts.enableSubagents && {
                                runSubagent,
                                parentSessionId: sessionId,
                                currentSubagentDepth: this.opts.currentSubagentDepth,
                            }),
                            ...(logger && { logger }),
                        },
                    }),
                });
            // Phase 5.5: when tool-search is opted in, the bridge's MCP tools are
            // HIDDEN from the model's initial tool pool. The model must call
            // `tool_search` + `tool_load` to bring them in, which pushes the
            // wrapped tool onto the shared `toolsForRun` array. When the opt-in
            // is off, every bridge tool is visible up front (prior 5.2.4 behaviour).
            const initialBridgeTools = this.opts.enableToolSearch ? [] : bridgeTools;
            const initialPool = [...baseTools, ...initialBridgeTools];
            for (const t of initialPool)
                toolsForRun.push(wrapTool(t));
            signal.addEventListener('abort', onAbort, { once: true });
            abortListenerInstalled = true;
            // Phase 5.3: multi-turn restart loop. Each iteration drains one
            // {@link UserInput} from the run's {@link StreamingInputSource}
            // (imperative queue first, then constructor `AsyncIterable`) and runs
            // ONE `callModel` cycle whose events are forwarded into the outer
            // event stream. Between cycles, any `partialResponse` left by a prior
            // `interrupt()` is committed as an assistant message into the
            // persisted history so the next cycle's model sees a faithful
            // transcript. The loop ends when the source is exhausted, a stop
            // condition (`max_turns` / `max_budget`) fires, the signal is
            // aborted, or an error throws — only then is a single trailing
            // `stream_complete` event yielded.
            let processedAnyInput = false;
            let interruptedReason;
            // Tracked across cycles so the run-wide `max_budget` guard fires
            // even when individual cycles stay under budget.
            // (totalCostUsd is the run-wide accumulator already.)
            //
            // Transient-failure retry carry. When a cycle dies with a TRANSIENT
            // terminal failure (`response.failed` code `server_error`/`overloaded`
            // or an HTTP 5xx — see {@link isTransientCycleFailure}), the catch arm
            // below sets this and `continue`s, so the next loop iteration re-runs
            // the SAME cycle instead of pulling new user input. Carries the
            // 0-based retry attempt number (compared against `maxTransientRetries`),
            // the failed cycle's request id (its request/user-transcript records
            // were already written — re-logging would duplicate them), and the
            // input for the re-issued callModel: the same fresh items when the
            // failed attempt never completed a response (the SDK persists fresh
            // items atomically with the assistant output, so state is untouched),
            // or `[]` when a FOLLOW-UP turn died (the fresh items are already in
            // state — the retry continues from history, never duplicating them).
            // Cleared on any successfully-completed cycle.
            let retryState = null;
            while (true) {
                let cycleRequestId;
                let cycleInput;
                if (retryState === null) {
                    // 1. Pull the next user input. Drains the imperative
                    //    pushUserMessage() queue first (FIFO), then the constructor
                    //    AsyncIterable<UserInput> if one was supplied. Done when both
                    //    are exhausted.
                    const inputResult = await this.#inputSource.next();
                    if (inputResult.done)
                        break;
                    processedAnyInput = true;
                    // 2. Commit any partial assistant text from a prior interrupt as
                    //    a proper assistant message in the persisted history. Drops
                    //    in-flight tool calls (their results never arrived; the next
                    //    user push moves past them). No-op on the very first cycle —
                    //    the SDK has not had a chance to populate `partialResponse`
                    //    yet, and skipping the load avoids an unnecessary FS hit.
                    if (processedAnyInput && interruptedReason !== undefined) {
                        try {
                            await commitPartialResponse(this.stateAccessor);
                        }
                        catch (err) {
                            logger?.('warn', 'Failed to commit partial response between turns', {
                                error: err,
                            });
                        }
                        // Once committed, clear the local marker — a subsequent
                        // interrupt within this loop will set it again.
                        interruptedReason = undefined;
                    }
                    // 3. Per-cycle request id + per-cycle request log entry. Each
                    //    callModel is its own request from OR's perspective; using
                    //    one id per cycle keeps `logs/<session>/req_*/` directories
                    //    in 1:1 correspondence with the wire calls.
                    cycleRequestId = createRequestId();
                    const cyclePromptForLog = typeof inputResult.value.content === 'string'
                        ? inputResult.value.content
                        : JSON.stringify(inputResult.value.content);
                    if (persistSession) {
                        await logRequest(logsRoot, {
                            sessionId,
                            requestId: cycleRequestId,
                            prompt: cyclePromptForLog,
                            timestamp: new Date().toISOString(),
                        });
                        await logTranscriptUser({ logsRoot, sessionId, text: cyclePromptForLog });
                    }
                    cycleInput = [userInputToCallModelItem(inputResult.value)];
                }
                else {
                    // Retry of the previous cycle. Steps 1–3 are skipped wholesale:
                    // no new input is pulled, no partial-response commit can be
                    // pending (interrupts exit the SDK gracefully — they never reach
                    // the retry catch arm), and the request/user-transcript records
                    // were written by the failed attempt already. Follow-up
                    // generations logged under the carried request id keep the
                    // `logs/<session>/req_*/` directory in 1:1 correspondence with
                    // the logical cycle.
                    cycleRequestId = retryState.requestId;
                    cycleInput = retryState.input;
                }
                // 4. Fire the callModel for this cycle. The state accessor is
                //    shared across cycles so the SDK's resume path picks up the
                //    accumulated `messages` history automatically.
                const result = client.callModel({
                    model,
                    sessionId,
                    input: cycleInput,
                    instructions,
                    tools: toolsForRun,
                    state,
                    stopWhen: [stepCountIs(maxTurns), maxCost(maxBudgetUsd)],
                    // Always request encrypted reasoning content. The agent never sends
                    // `store: true`, and OpenAI's Responses contract for store:false
                    // reasoning models only guarantees `encrypted_content` on reasoning
                    // items when this `include` is present — items without it cannot be
                    // faithfully echoed back on follow-up turns. OpenRouter currently
                    // forwards encrypted content on direct passthrough even without
                    // `include`, but requesting it explicitly is the documented contract
                    // and keeps sessions working if OR tightens to spec. Verified
                    // harmless for Anthropic (signature-carrying items, unaffected) and
                    // Gemini (own encrypted thought-signature items) routed models.
                    include: ['reasoning.encrypted_content'],
                    ...(this.opts.effort !== undefined && { reasoning: { effort: this.opts.effort } }),
                    // Forward OR auto-cache directive when set. Pinned SDK 0.12.35 doesn't
                    // declare `cacheControl` on `ResponsesRequest`, so we widen the
                    // typecheck here; the value flows through OR's request body once the
                    // SDK adds the field (or via passthrough at runtime on newer SDKs).
                    ...(this.opts.cacheControl !== undefined &&
                        {
                            cacheControl: this.opts.cacheControl,
                        }),
                    onTurnEnd: async (_turnCtx, response) => {
                        if (persistSession) {
                            const generationId = createGenerationId();
                            await logGeneration(logsRoot, {
                                sessionId,
                                requestId: cycleRequestId,
                                generationId,
                                response,
                                timestamp: new Date().toISOString(),
                            });
                        }
                        totalCostUsd += response.usage?.cost ?? 0;
                    },
                });
                resultHandle = result;
                // Late-aborted between callModel and stream attach.
                if (signal.aborted)
                    void result.cancel().catch(() => undefined);
                // Expose a per-cycle promise that `interrupt()` can await so the
                // host has a clean "stopped before next turn" handle. Resolved in
                // the finally below regardless of how the for-await unwinds.
                let resolveCycle = () => undefined;
                this.#currentCycle = new Promise((res) => {
                    resolveCycle = res;
                });
                // Track whether the SDK emitted a turn-end event during this
                // cycle. When an interrupt fires mid-cycle, the SDK exits its
                // own loop without yielding a turn-end; we synthesise one
                // afterwards so the rich message stream (`run.messages()`)
                // flushes the open `AssistantMessage` before the next cycle.
                let lastTurnNumber = 0;
                let turnEndEmitted = false;
                // Defense-in-depth: track whether the SDK emitted `response.completed`
                // during this cycle. When the SSE stream closes cleanly without this
                // event (e.g. an API error was swallowed by the SDK's internal error
                // path when server-tools hooks are in play), the `for await` loop exits
                // with no events and no throw — leaving the run in limbo. After the
                // loop we detect this situation and surface a synthetic error so the
                // consumer always sees `stream_complete{status:"error"}`.
                let responseCompleted = false;
                // Reset the failure capture for this attempt — a stale event from a
                // failed-and-retried predecessor cycle must not poison this attempt's
                // post-loop safety net or the outer catch's reason extraction.
                pendingFailedEvent = null;
                // Hung-stream watchdog for this cycle ATTEMPT (a transient retry of
                // the cycle creates a fresh monitor with a fresh clock). `0` disables
                // — the raw SDK stream is consumed directly, byte-identical to the
                // pre-watchdog behavior. Disposed in the cycle finally below (and
                // eagerly after a clean drain) so no timer outlives its cycle.
                const stallMonitor = this.opts.streamStallTimeoutMs > 0
                    ? createStallMonitor(this.opts.streamStallTimeoutMs, () => toolsInFlight > 0)
                    : undefined;
                activeStallMonitor = stallMonitor;
                const cycleStream = stallMonitor
                    ? monitorStream(result.getFullResponsesStream(), stallMonitor)
                    : result.getFullResponsesStream();
                try {
                    for await (const event of cycleStream) {
                        // Tool results emitted as part of an aborted run are still useful — they
                        // carry the cancellation observability for the consumer — so they are
                        // forwarded even after abort. Everything else (text deltas, turn
                        // start/end, tool_call announcements) is dropped post-abort.
                        if (isTurnStartEvent(event)) {
                            if (signal.aborted)
                                continue;
                            const turnNumber = event.turnNumber;
                            if (turnNumber > maxTurnNumber)
                                maxTurnNumber = turnNumber;
                            lastTurnNumber = turnNumber;
                            turnEndEmitted = false;
                            yield { type: 'turn_start', turnNumber };
                            continue;
                        }
                        if (isTurnEndEvent(event)) {
                            if (signal.aborted)
                                continue;
                            lastTurnNumber = event.turnNumber;
                            turnEndEmitted = true;
                            yield {
                                type: 'turn_end',
                                turnNumber: event.turnNumber,
                                usage: finalUsage,
                                costUsd: totalCostUsd,
                            };
                            continue;
                        }
                        if (isToolCallOutputEvent(event)) {
                            const out = event.output;
                            const isError = detectToolResultIsError(out);
                            yield {
                                type: 'tool_result',
                                callId: out.callId,
                                output: out.output,
                                isError,
                            };
                            if (persistSession) {
                                await logTranscriptToolResult({
                                    logsRoot,
                                    sessionId,
                                    callId: out.callId,
                                    name: toolCallNames.get(out.callId) ?? '',
                                    isError,
                                    output: out.output,
                                });
                            }
                            // After an abort, surface the tool result then stop iterating.
                            if (signal.aborted)
                                break;
                            continue;
                        }
                        if ('type' in event && event.type === 'response.output_text.delta') {
                            if (signal.aborted)
                                continue;
                            const delta = event.delta;
                            if (delta) {
                                yield { type: 'text_delta', content: delta };
                            }
                            continue;
                        }
                        // Live reasoning text from reasoning models (the SDK's
                        // `ReasoningDeltaEvent`). Mirrors the `text_delta` handling above:
                        // dropped post-abort, empty deltas skipped. Encrypted reasoning
                        // items never produce these events — only plaintext reasoning
                        // streams (see the `reasoning_delta` JSDoc in src/events.ts).
                        if ('type' in event && event.type === 'response.reasoning_text.delta') {
                            if (signal.aborted)
                                continue;
                            const delta = event.delta;
                            if (delta) {
                                yield { type: 'reasoning_delta', content: delta };
                            }
                            continue;
                        }
                        // A `response.failed` event means the request was accepted (200 + SSE
                        // established) but generation failed afterward (upstream provider
                        // error, moderation block, "no endpoints available", timeout, …).
                        //
                        // The SDK's own `consumeStreamForCompletion` consumer of the same
                        // broadcaster throws on `response.failed` — that rejects the cached
                        // `toolExecutionPromise`. `ModelResult.startTurnBroadcasterExecution`
                        // chains a `.finally(...)` onto it (model-result.js:234) and returns
                        // the chained promise as `executionPromise`. The SDK generator
                        // `getFullResponsesStream` awaits `executionPromise` AFTER its inner
                        // consumer loop drains (model-result.js:1586).
                        //
                        // If we throw here from the harness's consumer of the broadcast,
                        // our for-await closes the SDK generator via `iter.return()`
                        // BEFORE it reaches `await executionPromise;`. The chained promise
                        // is then orphaned, settles rejected with no observer, and Node
                        // surfaces it as `unhandledRejection` — crashing host processes
                        // (e.g. callboard) that have no global handler.
                        //
                        // Instead, capture the event and continue draining the broadcast.
                        // The SDK's own consumer will throw and reject `toolExecutionPromise`;
                        // `.finally(...)` will run `broadcaster.complete()`; our for-await
                        // exits naturally; the SDK generator advances past its for-await
                        // loop to `await executionPromise;` and observes the rejection,
                        // throwing into our for-await on the next iteration. The catch arm
                        // below then yields `error` + `stream_complete{status:"error"}`
                        // using `pendingFailedEvent` for the pretty reason.
                        //
                        // Abort still wins (matches the abort-first precedence elsewhere).
                        if ('type' in event && event.type === 'response.failed') {
                            if (signal.aborted)
                                continue;
                            pendingFailedEvent = event;
                            continue;
                        }
                        // `response.completed` fires once per SDK turn — the initial
                        // response (which may be the only one if there are no tool calls)
                        // AND every follow-up response. This is the right hook for the
                        // assistant transcript record: `onTurnEnd` only fires on
                        // follow-ups, so single-shot runs would otherwise leave no
                        // assistant record on disk.
                        if ('type' in event && event.type === 'response.completed') {
                            responseCompleted = true;
                            if (persistSession) {
                                const resp = event.response;
                                const extracted = extractAssistantContent(resp.output);
                                const usage = toTranscriptUsage(resp.usage);
                                const cost = typeof resp.usage?.cost === 'number' ? resp.usage.cost : 0;
                                const resolvedModel = typeof resp.model === 'string' ? resp.model : model;
                                await logTranscriptAssistant({
                                    logsRoot,
                                    sessionId,
                                    turnNumber: lastTurnNumber,
                                    requestId: cycleRequestId,
                                    model: resolvedModel,
                                    text: extracted.text,
                                    reasoning: extracted.reasoning,
                                    toolCalls: extracted.toolCalls,
                                    usage,
                                    costUsd: cost,
                                });
                            }
                            continue;
                        }
                        if ('type' in event && event.type === 'response.output_item.done') {
                            if (signal.aborted)
                                continue;
                            const item = event.item;
                            if (item.type === 'function_call') {
                                const fnItem = item;
                                let input;
                                try {
                                    input = JSON.parse(fnItem.arguments);
                                }
                                catch {
                                    input = fnItem.arguments;
                                }
                                toolCallNames.set(fnItem.callId, fnItem.name);
                                yield {
                                    type: 'tool_call',
                                    callId: fnItem.callId,
                                    name: fnItem.name,
                                    input,
                                };
                            }
                            else if (isServerToolOutputItem(item)) {
                                // OpenRouter server-executed tools (datetime / web_search /
                                // web_fetch). These bypass the client tool path entirely:
                                // OpenRouter runs them and returns a single output item that
                                // carries BOTH the invocation and its result. Emit a
                                // `server_tool` event (and persist a matching transcript
                                // record) so consumers can render them alongside client tools
                                // without inventing a synthetic call/result pair.
                                const normalized = normalizeServerToolItem(item);
                                yield {
                                    type: 'server_tool',
                                    toolType: normalized.toolType,
                                    ...(normalized.callId !== undefined && { callId: normalized.callId }),
                                    status: normalized.status,
                                    ...(normalized.input !== undefined && { input: normalized.input }),
                                    output: normalized.output,
                                    isError: normalized.isError,
                                };
                                if (persistSession) {
                                    await logTranscriptServerTool({
                                        logsRoot,
                                        sessionId,
                                        toolType: normalized.toolType,
                                        callId: normalized.callId,
                                        status: normalized.status,
                                        input: normalized.input,
                                        output: normalized.output,
                                        isError: normalized.isError,
                                    });
                                }
                            }
                            continue;
                        }
                    }
                    // The stream drained cleanly — stand the watchdog down BEFORE the
                    // post-loop safety nets: the `await result.getResponse()` below is
                    // a settled-promise fetch, not stream activity, and must never be
                    // racing a stall rejection.
                    stallMonitor?.dispose();
                    // Safety net for `response.failed`: if the harness captured a
                    // failed event but the SDK's own consumer somehow did not throw
                    // (or this cycle's SSE simply ended after the failure with no
                    // further events), surface it ourselves so the catch arm fires.
                    // When the SDK DID throw, our for-await already rethrew above and
                    // this block is unreachable — the throw goes straight to the catch.
                    if (pendingFailedEvent !== null && !signal.aborted) {
                        throw new Error(extractResponseFailedMessage(pendingFailedEvent));
                    }
                    // Defense-in-depth: if the SSE stream closed without ever emitting
                    // `response.completed` AND we are not in an abort/interrupt path,
                    // the SDK may have silently swallowed an API error (most commonly
                    // a 4xx rejected by the afterError hook returning {error:null}).
                    // Calling `result.getResponse()` will throw the pending rejection
                    // that `ModelResult.executeToolsIfNeeded` stored internally, surfacing
                    // it here so the outer catch converts it to `error` + `stream_complete`.
                    if (!responseCompleted && !signal.aborted) {
                        try {
                            await result.getResponse();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            throw new Error(msg, { cause: err });
                        }
                    }
                }
                catch (err) {
                    // Drain the SDK's internal executeToolsIfNeeded promise BEFORE
                    // deciding whether to retry — same rationale as the outer catch:
                    // a follow-up-turn `response.failed` rejects inside the SDK
                    // without completing the broadcaster, and leaving that rejection
                    // unobserved while we sleep through the backoff window would
                    // surface as an `unhandledRejection` that kills the host process.
                    void result.getResponse().catch(() => undefined);
                    // A stall means the SDK stream is dead but still "open" — tear the
                    // underlying request down so the dead connection doesn't linger
                    // across the retry (the orphaned iterator `next()` was already
                    // catch-drained inside monitorStream).
                    if (err instanceof StreamStallError) {
                        void result.cancel().catch(() => undefined);
                    }
                    // Explicit `: number` breaks a TS7022 circularity: the literal
                    // assigned to `retryState` below references this local, and the
                    // flow-narrowed type of `retryState` here depends on that literal.
                    const attempt = retryState?.attempt ?? 0;
                    const transient = !signal.aborted && isTransientCycleFailure(pendingFailedEvent, err);
                    if (!transient || attempt >= maxTransientRetries)
                        throw err;
                    const reason = pendingFailedEvent !== null
                        ? extractResponseFailedMessage(pendingFailedEvent)
                        : err instanceof Error
                            ? err.message
                            : String(err);
                    const backoffMs = transientRetryBaseDelayMs * 2 ** attempt;
                    logger?.('warn', 'Transient model failure — retrying cycle', {
                        reason,
                        attempt: attempt + 1,
                        maxRetries: maxTransientRetries,
                        backoffMs,
                    });
                    // `responseCompleted` means the SDK already persisted this cycle's
                    // fresh user items (atomically with that turn's assistant output)
                    // — re-sending them would duplicate the user turn in state, so the
                    // retry continues from the stored history with an empty input.
                    retryState = {
                        attempt: attempt + 1,
                        requestId: cycleRequestId,
                        input: responseCompleted ? [] : cycleInput,
                    };
                    pendingFailedEvent = null;
                    await sleepWithAbort(backoffMs, signal);
                    // Abort arrived during the backoff window — surface the original
                    // error to the outer catch (which converts it to the abort-reason
                    // stream_complete) rather than firing a request the caller no
                    // longer wants.
                    if (signal.aborted)
                        throw err;
                    continue;
                }
                finally {
                    // Idempotent re-dispose covers every unwind path (throw, abort
                    // break, retry continue) — a dangling watchdog timer would keep
                    // the event loop alive and leak across cycles/tests.
                    stallMonitor?.dispose();
                    activeStallMonitor = undefined;
                    resolveCycle();
                    this.#currentCycle = undefined;
                }
                // The cycle ran to completion — drop any retry carry so the next
                // iteration pulls fresh user input again.
                retryState = null;
                if (signal.aborted) {
                    // Drain the SDK's internal executeToolsIfNeeded promise so a
                    // follow-up-turn `response.failed` (which throws inside the SDK
                    // without completing the broadcaster) doesn't surface as an
                    // unhandled rejection and kill the host process. The harness
                    // has already extracted the failure reason from the broadcast
                    // event and is yielding stream_complete { status: 'error' },
                    // so the SDK's rejection is redundant — swallow it.
                    if (resultHandle) {
                        void resultHandle.getResponse().catch(() => undefined);
                    }
                    yield {
                        type: 'stream_complete',
                        status: 'error',
                        usage: finalUsage,
                        costUsd: totalCostUsd,
                        durationMs: Date.now() - startMs,
                        reason: ABORT_REASON,
                    };
                    sessionEndPayload = {
                        event: 'SessionEnd',
                        sessionId,
                        status: 'error',
                        usage: finalUsage,
                        costUsd: totalCostUsd,
                    };
                    stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
                    return;
                }
                const response = await result.getResponse();
                finalUsage = response.usage ?? finalUsage;
                const finalCost = response.usage?.cost ?? 0;
                // Guard against double-counting: only adopt the final cost when
                // no per-turn onTurnEnd callback fired for this cycle (e.g.
                // single-shot no-tool-call cycle). totalCostUsd already
                // accumulates across cycles, so we only top up when this cycle
                // contributed nothing.
                if (totalCostUsd === 0 && finalCost > 0) {
                    totalCostUsd = finalCost;
                }
                if (persistSession) {
                    const finalGenId = createGenerationId();
                    await logGeneration(logsRoot, {
                        sessionId,
                        requestId: cycleRequestId,
                        generationId: finalGenId,
                        response,
                        timestamp: new Date().toISOString(),
                    });
                }
                // 5. Detect whether this cycle ended due to an interrupt. The
                //    SDK persists `status: 'interrupted'` + `partialResponse`
                //    into state when its checkForInterruption polling exits.
                //    On interrupt we synth a turn_end (if not already emitted)
                //    to flush messages(), record the reason, and loop back to
                //    pull the next user input.
                const stateAfter = await this.stateAccessor.load();
                const stateStatus = stateAfter?.status;
                if (stateStatus === 'interrupted') {
                    const reason = stateAfter?.interruptedBy ?? 'interrupted';
                    interruptedReason = reason;
                    if (!turnEndEmitted) {
                        yield {
                            type: 'turn_end',
                            turnNumber: lastTurnNumber,
                            usage: finalUsage,
                            costUsd: totalCostUsd,
                        };
                    }
                    // The next iteration's `commitPartialResponse` call will fold
                    // the captured assistant text into the conversation history
                    // before the next callModel runs.
                    continue;
                }
                // 6. Apply the per-cycle stop-condition derivation. The
                //    cost guard is run-wide (totalCostUsd accumulates across
                //    cycles); the turn-count guard reflects only this cycle's
                //    observed turns. Both `max_budget` and `max_turns`
                //    terminate the outer loop — multi-turn streaming-input
                //    sessions wanting unlimited turns should set generous
                //    `maxTurns` / `maxBudgetUsd` ceilings.
                const cycleStatus = deriveCompletionStatus({
                    totalCostUsd,
                    maxBudgetUsd,
                    maxTurnNumber,
                    maxTurns,
                });
                status = cycleStatus;
                if (cycleStatus === 'max_budget' || cycleStatus === 'max_turns') {
                    break;
                }
            }
            // 7. Loop ended cleanly (input exhausted or stop condition fired).
            //    Three completion paths converge here:
            //    - no input ever drained (e.g. empty AsyncIterable) → status was
            //      never written off its `'error'` default; treat as no-op success.
            //    - last cycle ran to completion → status was set to `'success'` /
            //      `'max_budget'` / `'max_turns'` inside the loop.
            //    - every cycle ended via host-interrupt → status was never
            //      written (interrupt skips the status assignment); treat as
            //      success because the run did not throw.
            if (status === 'error') {
                status = 'success';
            }
            // Stage the SessionEnd / Stop payloads BEFORE yielding so a consumer
            // that `break`s on `stream_complete` still gets the trailing hooks
            // fired from finally. (Generator return() resumes at the yield and
            // unwinds straight to finally — code after the yield never runs.)
            sessionEndPayload = {
                event: 'SessionEnd',
                sessionId,
                status,
                usage: finalUsage,
                costUsd: totalCostUsd,
            };
            stopPayload = interruptedReason
                ? { event: 'Stop', status, reason: interruptedReason }
                : { event: 'Stop', status };
            yield {
                type: 'stream_complete',
                status,
                usage: finalUsage,
                costUsd: totalCostUsd,
                durationMs: Date.now() - startMs,
                ...(interruptedReason !== undefined && { reason: interruptedReason }),
            };
        }
        catch (err) {
            // Drain the SDK's internal executeToolsIfNeeded promise so a
            // follow-up-turn `response.failed` (which throws inside the SDK
            // without completing the broadcaster) doesn't surface as an
            // unhandled rejection and kill the host process. The harness
            // has already extracted the failure reason from the broadcast
            // event and is yielding stream_complete { status: 'error' },
            // so the SDK's rejection is redundant — swallow it.
            if (resultHandle) {
                void resultHandle.getResponse().catch(() => undefined);
            }
            if (signal.aborted) {
                yield {
                    type: 'stream_complete',
                    status: 'error',
                    usage: finalUsage,
                    costUsd: totalCostUsd,
                    durationMs: Date.now() - startMs,
                    reason: ABORT_REASON,
                };
                sessionEndPayload = {
                    event: 'SessionEnd',
                    sessionId,
                    status: 'error',
                    usage: finalUsage,
                    costUsd: totalCostUsd,
                };
                stopPayload = { event: 'Stop', status: 'error', reason: ABORT_REASON };
                return;
            }
            // If a `response.failed` event was captured mid-stream, prefer its
            // pretty-printed reason (e.g. `server_error: Internal Server Error`)
            // over whatever bubbled up — when the SDK's own consumer rethrew it,
            // the message is the JSON-stringified error envelope.
            const message = pendingFailedEvent !== null
                ? extractResponseFailedMessage(pendingFailedEvent)
                : err instanceof Error
                    ? err.message
                    : String(err);
            // Structured failure context: routing metadata off the failed event, or
            // statusCode/body off an HTTP-level SDK error. The serialized event is
            // logger-only (it can be large); `detail` rides on the error event so
            // hosts can log provider/attempt specifics without re-parsing `message`.
            const detail = pendingFailedEvent !== null
                ? extractResponseFailedDetail(pendingFailedEvent)
                : extractHttpErrorDetail(err);
            logger?.('error', 'OpenRouterAgentRun stream errored', {
                message,
                ...(detail !== undefined && { detail }),
                ...(pendingFailedEvent !== null && {
                    failedEvent: truncateForLog(safeJsonStringify(pendingFailedEvent), MAX_LOG_FAILED_EVENT_CHARS),
                }),
            });
            yield { type: 'error', message, cause: err, ...(detail !== undefined && { detail }) };
            yield {
                type: 'stream_complete',
                status: 'error',
                usage: finalUsage,
                costUsd: totalCostUsd,
                durationMs: Date.now() - startMs,
                reason: message,
            };
            sessionEndPayload = {
                event: 'SessionEnd',
                sessionId,
                status: 'error',
                usage: finalUsage,
                costUsd: totalCostUsd,
            };
            stopPayload = { event: 'Stop', status: 'error', reason: message };
        }
        finally {
            if (abortListenerInstalled) {
                signal.removeEventListener('abort', onAbort);
            }
            // Phase 5.2.4: tear down every MCP server the bridge spawned. Safe to
            // call before init (no-op) and idempotent. Per-server close errors
            // are swallowed inside the bridge so a misbehaving server can't break
            // the rest of the cleanup path.
            if (this.#mcpBridge) {
                const bridge = this.#mcpBridge;
                this.#mcpBridge = undefined;
                try {
                    await bridge.close();
                }
                catch (err) {
                    logger?.('error', 'MCP bridge close failed', { error: err });
                }
            }
            // Phase 5.8: fire PluginStop for every plugin that fired PluginStart.
            // Pairs 1:1 with PluginStart; durations come from `pluginStartTimes`.
            // Plugins for which PluginStart did NOT fire (run aborted pre-bridge,
            // or constructor throw) silently skip — their LoadedPlugin had no
            // observable lifecycle to bracket.
            for (const plugin of this.opts.plugins) {
                const startedAt = pluginStartTimes.get(plugin.manifest.name);
                if (startedAt === undefined)
                    continue;
                await safeFireHook('PluginStop', {
                    event: 'PluginStop',
                    pluginName: plugin.manifest.name,
                    durationMs: Date.now() - startedAt,
                    reason: 'closed',
                });
            }
            // Clear the iter guard BEFORE the auto-compact call so the auto-trigger
            // (which calls this.compact('auto')) does not throw on its own guard.
            this.#isIterating = false;
            // Phase 5.1: auto-compaction fires here (in the generator's `finally`)
            // so it triggers on any non-error completion regardless of whether the
            // consumer drained to end-of-stream or `break`ed early on
            // `stream_complete` — the generator's `return()` still runs finally.
            // `max_turns` / `max_budget` runs still produced a useful turn worth
            // condensing. Errors from the summarizer call are caught so the
            // SessionEnd / Stop hook bracket below still fires.
            if (this.opts.autoCompact && status !== 'error') {
                try {
                    const persistedState = await this.stateAccessor.load();
                    const messages = persistedState?.messages;
                    if (this.isOverCompactionThreshold(messages)) {
                        await this.compact('auto');
                    }
                }
                catch (err) {
                    logger?.('error', 'Auto-compaction failed', { error: err });
                }
            }
            if (sessionEndPayload) {
                await safeFireHook('SessionEnd', sessionEndPayload);
                if (persistSession && transcriptStarted) {
                    const totalUsage = toTranscriptUsage(sessionEndPayload.usage);
                    await logTranscriptSessionEnd({
                        logsRoot,
                        sessionId,
                        status: sessionEndPayload.status,
                        reason: stopPayload.reason,
                        totalUsage,
                        totalCostUsd: sessionEndPayload.costUsd,
                    });
                }
            }
            // Stop is the last hook event in the run. Fires regardless of how we
            // exited iterate(); when the run somehow exited without setting
            // stopPayload, the default 'error' captured at init time is used.
            await safeFireHook('Stop', stopPayload);
        }
    }
}
/**
 * Wrap a Tool's execute with a canUseTool permission check. The original
 * tool is shallow-cloned (preserving inputSchema, description, etc.) and only
 * `execute` is replaced. On `deny`, the wrapper throws an Error whose message
 * is `JSON.stringify({ error, denied: true })`. The OR SDK's
 * `executeRegularTool` catches that throw and JSON-stringifies an outer
 * `{"error": <thrown.message>}` envelope around it, emitting a normal
 * `function_call_output` (NOT `status: 'incomplete'`). `detectToolResultIsError`
 * inspects that envelope shape and surfaces the result with `isError: true`.
 * Consumers wanting to distinguish denial from generic failure can
 * `JSON.parse(toolResult.output)` and (after a second parse of the inner
 * `error` string) check `denied === true`.
 */
function wrapToolWithPermission(t, canUseTool) {
    // Server tools run on OpenRouter — no client-side execute to gate. Pass through.
    if (!isClientTool(t))
        return t;
    const fn = t.function;
    const name = fn.name;
    const originalExecute = fn.execute;
    // Tools without a local execute (e.g. SDK "manual" or generator forms) run
    // outside our wrapper; pass them through unchanged.
    if (typeof originalExecute !== 'function')
        return t;
    const wrappedExecute = async (input, ctx) => {
        const canUseCtx = {
            signal: new AbortController().signal,
            suggestions: [],
        };
        let decision;
        try {
            decision = await canUseTool(name, input, canUseCtx);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(JSON.stringify({ error: reason, denied: true }), { cause: err });
        }
        if (decision.behavior === 'deny') {
            throw new Error(JSON.stringify({ error: decision.reason, denied: true }));
        }
        const effectiveInput = decision.updatedInput !== undefined ? decision.updatedInput : input;
        return originalExecute(effectiveInput, ctx);
    };
    return {
        ...t,
        function: {
            ...t.function,
            execute: wrappedExecute,
        },
    };
}
/**
 * Built-in tools exempt from the {@link OpenRouterAgentRunOptions.toolTimeoutMs}
 * deadline: `bash` and `monitor` carry their own model-controllable timeouts
 * (`timeout_ms` / `max_duration_ms`, each clamped to 10 min); the subagent
 * spawners are long-running by design (bounded by each child's own
 * `maxTurns` / `maxBudgetUsd` instead); `ask_user_question` blocks on a
 * human answering via the host's `onAskUserQuestion` handler (user thinking
 * time is not a tool failure — the permission-prompt wait is likewise
 * outside the deadline, by wrapper ordering); `skill` drives an entire
 * subagent run inside execute for `context: fork` skills. MCP-bridged tools
 * are exempted separately by their `<serverName>__<toolName>` name marker —
 * see {@link isToolTimeoutExempt}.
 */
const TOOL_TIMEOUT_EXEMPT_NAMES = new Set([
    'bash',
    'spawn_subagent',
    'spawn_subagents',
    'ask_user_question',
    'monitor',
    'skill',
]);
/**
 * Whether a client tool name is exempt from the per-tool execute deadline.
 * Exact-name matches against {@link TOOL_TIMEOUT_EXEMPT_NAMES}, plus any
 * name containing the MCP bridge's `__` separator (`<serverName>__<toolName>`
 * — external servers own their timeout semantics). The separator check is a
 * substring test, so a custom tool whose name happens to contain `__` is
 * also (conservatively) exempt — documented on the option JSDoc.
 */
function isToolTimeoutExempt(name) {
    return TOOL_TIMEOUT_EXEMPT_NAMES.has(name) || name.includes(MCP_TOOL_NAME_SEPARATOR);
}
/**
 * Wrap a Tool's execute with a settle-or-timeout race (the
 * {@link OpenRouterAgentRunOptions.toolTimeoutMs} deadline). Composed as the
 * INNERMOST wrapper — directly around the ctx-bound execute, inside the
 * permission/hook wrappers — so a timeout surfaces through `PostToolUse` and
 * the `tool_result` exactly like any other tool failure. On timeout the
 * wrapper throws `JSON.stringify({ error, timedOut: true })`, mirroring the
 * `canUseTool` deny convention ({@link wrapToolWithPermission}): the OR SDK
 * catches the throw, wraps it in its own `{"error": …}` envelope, and
 * {@link detectToolResultIsError} flags the result. The losing execute
 * promise gets a no-op `.catch` so its later settlement never becomes an
 * `unhandledRejection`; its underlying I/O is NOT cancelled (no signal
 * plumbing in v1 — the loop just stops waiting).
 *
 * Pass-throughs: `timeoutMs <= 0` (disabled), server tools (no client-side
 * execute), tools without a local execute, and {@link isToolTimeoutExempt}
 * names.
 */
function wrapToolWithTimeout(t, timeoutMs) {
    if (timeoutMs <= 0 || !isClientTool(t))
        return t;
    const fn = t.function;
    const name = fn.name;
    const originalExecute = fn.execute;
    if (typeof originalExecute !== 'function' || isToolTimeoutExempt(name))
        return t;
    const wrappedExecute = async (input, ctx) => {
        let timer;
        const deadline = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(JSON.stringify({
                    error: `tool ${name} timed out after ${timeoutMs}ms`,
                    timedOut: true,
                })));
            }, timeoutMs);
        });
        const execution = Promise.resolve(originalExecute(input, ctx));
        try {
            return await Promise.race([execution, deadline]);
        }
        catch (err) {
            // When the deadline won, `execution` is orphaned and may reject later
            // — attach a no-op handler so it can't become an unhandledRejection.
            // When `execution` itself threw, the extra handler is harmless (the
            // rejection was already observed via the race).
            void execution.catch(() => undefined);
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    };
    return {
        ...t,
        function: {
            ...t.function,
            execute: wrappedExecute,
        },
    };
}
/**
 * Wrap a Tool's execute with {@link ToolActivitySink} begin/end signals.
 * Composed OUTERMOST and UNCONDITIONALLY (unlike the permission/hook
 * wrappers, which only apply when their callbacks are wired) so the stall
 * watchdog's suspension covers the entire tool pipeline — PreToolUse hooks,
 * permission prompts (which can block on a human for minutes), and the
 * execute itself — for every tool path: built-ins, custom tools, and
 * MCP-bridge tools all flow through the single `wrapTool` composition in
 * the agent loop. Server tools and execute-less tool forms pass through
 * untouched (nothing client-side runs for them, so there is no silence to
 * excuse).
 */
function wrapToolWithActivityTracker(t, sink) {
    if (!isClientTool(t))
        return t;
    const fn = t.function;
    const originalExecute = fn.execute;
    if (typeof originalExecute !== 'function')
        return t;
    const wrappedExecute = async (input, ctx) => {
        sink.begin();
        try {
            return await originalExecute(input, ctx);
        }
        finally {
            sink.end();
        }
    };
    return {
        ...t,
        function: {
            ...t.function,
            execute: wrappedExecute,
        },
    };
}
/**
 * Wrap a Tool's execute with PreToolUse / PostToolUse hook firings. Composed
 * OUTSIDE {@link wrapToolWithPermission} so that PreToolUse fires before the
 * canUseTool decision (audit always fires, even on deny) and PostToolUse fires
 * after the inner execute resolves — propagating any thrown error (including
 * the synth-deny payload from a permission denial OR a hook `block`) as the
 * PostToolUse output.
 *
 * Phase 3.7: `PreToolUse` may return a {@link PreToolUseAction}.
 *
 * - `block` synthesises the same `{ error, denied: true }` JSON shape used by
 *   {@link wrapToolWithPermission}, throws it (so the OR SDK marks the tool
 *   result as `status: 'incomplete'`), and lets the catch arm fire a single
 *   `PostToolUse` carrying the synth output. `canUseTool` is NEVER consulted
 *   on block — precedence: hook-block > canUseTool-allow.
 * - `modify` substitutes the input that flows into `originalExecute` (which
 *   IS the `canUseTool` wrapper when one is wired), so the modified input is
 *   what `canUseTool` decides on and what the underlying tool runs against.
 *   The `tool_call` event the consumer sees is unchanged — `modify` is
 *   invisible at the event-stream layer except for the eventual
 *   `tool_result`. `PreToolUse.input` reflects the ORIGINAL input (the hook
 *   already decided to modify; echoing the change is redundant);
 *   `PostToolUse.input` also stays original for symmetry with how
 *   `canUseTool`'s `updatedInput` is invisible there.
 * - `continue` (or a `void` / `undefined` return — the historical contract)
 *   leaves the call unchanged.
 *
 * Precedence the other way round — `canUseTool` may still deny after the
 * hook returns `continue`/`modify`; that deny wins, the hook's intent is
 * overridden, and the consumer sees the canUseTool reason in the tool result.
 *
 * The OR SDK's `ToolExecuteContext` carries the live `FunctionCallItem` on
 * `ctx.toolCall`, so the SDK-issued call id is preferred. When that is absent
 * (custom tools wired without the standard SDK context, or tests that pass a
 * bare `{}`), a synthetic UUID is generated for the hook payload — the two
 * payloads of a single Pre/Post pair always share the same id.
 */
function wrapToolWithHooks(t, safeFireHook, logger) {
    // Server tools run on OpenRouter — no client-side execute to wrap. Pass through.
    if (!isClientTool(t))
        return t;
    const fn = t.function;
    const name = fn.name;
    const originalExecute = fn.execute;
    if (typeof originalExecute !== 'function')
        return t;
    const wrappedExecute = async (input, ctx) => {
        const sdkCallId = ctx?.toolCall?.callId;
        const callId = typeof sdkCallId === 'string' && sdkCallId.length > 0 ? sdkCallId : randomUUID();
        // Merge ctx.notify onto the SDK-supplied ToolExecuteContext so tools
        // (built-in or custom) can emit Notification hooks. Object.assign tolerates
        // a missing source ctx (returns just the notify-bearing object), so there's
        // no need to branch on ctx shape — the wrapper is only ever applied when
        // onHook is wired, so notify is always present in the merged result.
        const ctxWithNotify = Object.assign({}, ctx, {
            notify: (level, message, context) => safeFireHook('Notification', { event: 'Notification', level, message, context }),
        });
        const preResult = await safeFireHook('PreToolUse', {
            event: 'PreToolUse',
            toolName: name,
            input,
            callId,
        });
        const preAction = parsePreToolUseAction(preResult, name, logger);
        const effectiveInput = preAction.action === 'modify' ? preAction.input : input;
        try {
            if (preAction.action === 'block') {
                // Throw with the same JSON shape canUseTool's deny path uses so the
                // synth `tool_result` payload is shape-identical between the two
                // denial sources. The catch arm fires PostToolUse with the JSON as
                // output, then re-throws so the SDK marks the tool result incomplete.
                throw new Error(JSON.stringify({ error: preAction.reason, denied: true }));
            }
            const output = await originalExecute(effectiveInput, ctxWithNotify);
            await safeFireHook('PostToolUse', {
                event: 'PostToolUse',
                toolName: name,
                input,
                output,
                isError: false,
                callId,
            });
            return output;
        }
        catch (err) {
            const output = err instanceof Error ? err.message : String(err);
            await safeFireHook('PostToolUse', {
                event: 'PostToolUse',
                toolName: name,
                input,
                output,
                isError: true,
                callId,
            });
            throw err;
        }
    };
    return {
        ...t,
        function: {
            ...t.function,
            execute: wrappedExecute,
        },
    };
}
/**
 * Validate the raw value returned by a `PreToolUse` handler into a
 * {@link PreToolUseAction}. `null`/`undefined`/`void` returns (the
 * backward-compat path) become `continue`. Malformed objects (wrong shape,
 * unrecognised `action`, missing `reason`/`input`) also become `continue`,
 * with a `warn`-level log so the misuse is visible. This keeps the run alive
 * — silently degrading to "tool executes" is safer than translating a
 * malformed return into an accidental block.
 */
function parsePreToolUseAction(raw, toolName, logger) {
    if (raw == null)
        return { action: 'continue' };
    if (typeof raw !== 'object') {
        logger?.('warn', 'PreToolUse handler returned a non-object; treating as continue', {
            toolName,
            returned: raw,
        });
        return { action: 'continue' };
    }
    const obj = raw;
    if (obj.action === 'continue')
        return { action: 'continue' };
    if (obj.action === 'block') {
        if (typeof obj.reason === 'string')
            return { action: 'block', reason: obj.reason };
        logger?.('warn', 'PreToolUse block action missing string `reason`; treating as continue', {
            toolName,
        });
        return { action: 'continue' };
    }
    if (obj.action === 'modify') {
        if ('input' in obj)
            return { action: 'modify', input: obj.input };
        logger?.('warn', 'PreToolUse modify action missing `input` field; treating as continue', {
            toolName,
        });
        return { action: 'continue' };
    }
    logger?.('warn', 'PreToolUse handler returned unrecognised action; treating as continue', {
        toolName,
        action: obj.action,
    });
    return { action: 'continue' };
}
/**
 * Build the `named` argument map a skill body's `$<name>` substitutions read
 * from. The frontmatter's `arguments: [foo, bar]` list pairs positionally with
 * the runtime argv — entry 0 maps to `$foo`, entry 1 maps to `$bar`. Missing
 * positions resolve to empty strings (matches Claude Code's documented
 * behaviour for "argument never supplied").
 */
function namedFromPositional(names, args) {
    const out = {};
    for (let i = 0; i < names.length; i++) {
        out[names[i]] = i < args.length ? args[i] : '';
    }
    return out;
}
/**
 * Walk a {@link OpenResponsesResult.output} array and pull out the user-visible
 * pieces a transcript record cares about — concatenated assistant text,
 * concatenated reasoning text, and the list of tool calls the turn issued.
 * Best-effort: unknown item shapes are skipped silently rather than throwing,
 * so transcript writes never block the run on SDK schema drift.
 */
/**
 * `response.failed` error codes that indicate a TRANSIENT upstream condition
 * worth retrying — the request was valid but the provider (or OR's edge)
 * failed to serve it this time. Everything else (moderation blocks,
 * invalid-request shapes, context overflow, …) is deterministic: retrying
 * would re-spend budget for the same outcome.
 */
const TRANSIENT_FAILURE_CODES = new Set(['server_error', 'overloaded']);
/** Read a numeric `statusCode` property off an arbitrary value, if present. */
function statusCodeAt(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const code = value.statusCode;
    return typeof code === 'number' ? code : undefined;
}
/**
 * Find the numeric `statusCode` that `@openrouter/sdk`'s `OpenRouterError`
 * hierarchy exposes on HTTP-level failures. Checks the error itself, then one
 * `cause` hop — the post-loop silent-hang safety net rethrows the SDK error
 * wrapped as `new Error(msg, { cause })`, which would otherwise hide the code.
 */
function extractStatusCode(err) {
    return statusCodeAt(err) ?? statusCodeAt(err?.cause);
}
/**
 * Classify a failed callModel cycle as transient (worth retrying) or not.
 *
 * A {@link StreamStallError} (hung-stream watchdog fired) is always
 * transient — a dead connection is exactly the class of failure a fresh
 * cycle attempt heals — and is checked first because a stall says nothing
 * about any `response.failed` event that may have been captured earlier in
 * the same attempt. Otherwise: when a `response.failed` event was captured
 * for the attempt, its structured `response.error.code` is authoritative —
 * the SDK's own rethrow of the same failure is a `JSON.stringify` of that
 * envelope, so falling through to the thrown error would just re-parse
 * worse data. Only `server_error` / `overloaded` codes qualify. Without a
 * captured event (HTTP-level failure before the SSE stream established, or
 * the silent-hang surfacing path), an HTTP 5xx-class `statusCode` on the
 * thrown error (or its `cause`) qualifies. Everything else — 4xx-class
 * errors, moderation, unknown shapes — is non-retryable; aborts are
 * excluded by the caller before this is consulted.
 */
function isTransientCycleFailure(failedEvent, err) {
    if (err instanceof StreamStallError)
        return true;
    if (failedEvent !== null) {
        const code = failedEvent
            .response?.error?.code;
        return typeof code === 'string' && TRANSIENT_FAILURE_CODES.has(code);
    }
    const statusCode = extractStatusCode(err);
    return statusCode !== undefined && statusCode >= 500;
}
/**
 * Abort-aware sleep used for the backoff window between transient-failure
 * retry attempts. Resolves (never rejects) after `ms` milliseconds OR as soon
 * as the signal aborts — the caller re-checks `signal.aborted` afterwards and
 * converts the pending retry into a normal abort unwind. Callers must pass a
 * not-yet-aborted signal (the retry catch arm only reaches this after its
 * `!signal.aborted` transient check, with no awaits in between) — a listener
 * added to an already-aborted signal would never fire.
 */
function sleepWithAbort(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Pull the most useful human-readable text out of a `response.failed` stream
 * event. The richest detail lives at `event.response.error.message` (with a
 * machine `code`, e.g. `server_error`/`rate_limit_exceeded`); we prefix the
 * code when present so the surfaced `reason` mirrors the body-bearing style of
 * the SDK's HTTP-level `OpenRouterDefaultError`. Falls back, in order, to a
 * top-level `event.message` (what the follow-up `pipeAndConsumeStream` path
 * reads), then `response.incompleteDetails.reason`, then a generic label.
 * When the event carries routing context ({@link extractResponseFailedDetail})
 * a compact one-line suffix is appended — e.g.
 * `server_error: Internal Server Error (resp_abc openai/gpt-5; attempts: openai→500)`.
 */
function extractResponseFailedMessage(event) {
    const e = event;
    const suffix = formatResponseFailedSuffix(extractResponseFailedDetail(event));
    const err = e.response?.error;
    if (err && typeof err.message === 'string' && err.message.length > 0) {
        const base = typeof err.code === 'string' && err.code.length > 0
            ? `${err.code}: ${err.message}`
            : err.message;
        return `${base}${suffix}`;
    }
    if (typeof e.message === 'string' && e.message.length > 0)
        return `${e.message}${suffix}`;
    const reason = e.response?.incompleteDetails?.reason;
    if (typeof reason === 'string' && reason.length > 0)
        return `${reason}${suffix}`;
    return `Response failed${suffix}`;
}
/**
 * Extract structured failure context from a `response.failed` event: the
 * response `id`/`model` plus OpenRouter routing metadata (`openrouterMetadata`
 * survives the SDK's parsing even though `response.error` itself is stripped
 * to `{code, message}`). Every field is optional and unknown-shaped input
 * never throws. Returns `undefined` when nothing usable is present.
 */
function extractResponseFailedDetail(event) {
    const resp = event.response;
    if (resp === null || typeof resp !== 'object')
        return undefined;
    const r = resp;
    const detail = {};
    if (typeof r.id === 'string')
        detail.responseId = r.id;
    if (typeof r.model === 'string')
        detail.model = r.model;
    const meta = r.openrouterMetadata;
    if (meta !== null && meta !== undefined && typeof meta === 'object') {
        if (typeof meta.summary === 'string')
            detail.routingSummary = meta.summary;
        if (typeof meta.requested === 'string')
            detail.requested = meta.requested;
        if (typeof meta.region === 'string')
            detail.region = meta.region;
        if (Array.isArray(meta.attempts)) {
            const attempts = [];
            for (const raw of meta.attempts) {
                if (raw === null || typeof raw !== 'object')
                    continue;
                const a = raw;
                const attempt = {};
                if (typeof a.model === 'string')
                    attempt.model = a.model;
                if (typeof a.provider === 'string')
                    attempt.provider = a.provider;
                if (typeof a.status === 'number')
                    attempt.status = a.status;
                if (Object.keys(attempt).length > 0)
                    attempts.push(attempt);
            }
            if (attempts.length > 0)
                detail.attempts = attempts;
        }
    }
    return Object.keys(detail).length > 0 ? detail : undefined;
}
/** Cap on routing attempts rendered into the human-readable failure suffix. */
const MAX_SUFFIX_ATTEMPTS = 5;
/** Cap on the routing-summary excerpt rendered into the failure suffix. */
const MAX_SUFFIX_SUMMARY_CHARS = 200;
/**
 * Render {@link extractResponseFailedDetail} output as a compact one-line
 * ` (…)` suffix for the surfaced failure reason: response id + model, then
 * up to {@link MAX_SUFFIX_ATTEMPTS} attempts as `provider→status`, then a
 * truncated routing summary. Empty string when there is no detail.
 */
function formatResponseFailedSuffix(detail) {
    if (detail === undefined)
        return '';
    const parts = [];
    const head = [detail.responseId, detail.model].filter((v) => typeof v === 'string' && v.length > 0);
    if (head.length > 0)
        parts.push(head.join(' '));
    const attempts = detail.attempts;
    // The extractor only sets `attempts` when non-empty, so no length guard.
    if (Array.isArray(attempts)) {
        const rendered = attempts
            .slice(0, MAX_SUFFIX_ATTEMPTS)
            .map((a) => `${a.provider ?? '?'}→${a.status ?? '?'}`);
        const extra = attempts.length > MAX_SUFFIX_ATTEMPTS
            ? `, +${attempts.length - MAX_SUFFIX_ATTEMPTS} more`
            : '';
        parts.push(`attempts: ${rendered.join(', ')}${extra}`);
    }
    if (typeof detail.routingSummary === 'string' && detail.routingSummary.length > 0) {
        parts.push(truncateForLog(detail.routingSummary, MAX_SUFFIX_SUMMARY_CHARS));
    }
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}
/** Cap on the raw HTTP error body included in failure detail. */
const MAX_DETAIL_BODY_CHARS = 2000;
/** Cap on the serialized `response.failed` event included in logger fields. */
const MAX_LOG_FAILED_EVENT_CHARS = 4000;
/**
 * Extract structured failure context from an HTTP-level SDK error: the
 * `statusCode` and raw `body` that `@openrouter/sdk`'s `OpenRouterError`
 * hierarchy exposes. Like {@link extractStatusCode}, checks the error itself
 * then one `cause` hop. Returns `undefined` when neither is present.
 */
function extractHttpErrorDetail(err) {
    const statusCode = extractStatusCode(err);
    const body = bodyAt(err) ?? bodyAt(err?.cause);
    const detail = {};
    if (statusCode !== undefined)
        detail.statusCode = statusCode;
    if (body !== undefined)
        detail.body = truncateForLog(body, MAX_DETAIL_BODY_CHARS);
    return Object.keys(detail).length > 0 ? detail : undefined;
}
/** Read a non-empty string `body` property off an arbitrary value, if present. */
function bodyAt(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const body = value.body;
    return typeof body === 'string' && body.length > 0 ? body : undefined;
}
/** Truncate `value` to `max` characters, marking the cut. */
function truncateForLog(value, max) {
    return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}
/** JSON-stringify that never throws (circular refs, BigInt, …). */
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Decide whether a `tool.call_output` event represents a failed call. The OR
 * SDK only sets `status: 'incomplete'` for a narrow class of failures (e.g.
 * cancellation). Errors thrown from a tool's `execute()` are caught by
 * `executeRegularTool`, JSON-stringified into an `{"error": <message>}`
 * envelope, and emitted as a normal `function_call_output` with no `status`
 * field — so `out.status === 'incomplete'` alone misses every thrown error.
 *
 * We additionally inspect the serialized output for two markers:
 *
 *  (a) the SDK catch-arm envelope `{"error":"..."}` (sole `error` key, string
 *      value). `wrapToolWithPermission` and `wrapToolWithHooks` throw with a
 *      `JSON.stringify({error, denied: true})` body, which the SDK then wraps
 *      again as `{"error": <that JSON string>}` — both shapes match.
 *  (b) a structured `isError: true` field on a tool-emitted object — tools
 *      that resolve (rather than throw) can opt in to the failure signal by
 *      setting this on their result. The production `bash` tool uses this to
 *      surface non-zero exits, kill signals, and pre-spawn cancellation
 *      without coupling to the SDK's catch-path behavior.
 */
function detectToolResultIsError(out) {
    if (out.status === 'incomplete')
        return true;
    if (typeof out.output !== 'string')
        return false;
    let parsed;
    try {
        parsed = JSON.parse(out.output);
    }
    catch {
        return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    const obj = parsed;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === 'error' && typeof obj.error === 'string')
        return true;
    if (obj.isError === true)
        return true;
    return false;
}
function extractAssistantContent(output) {
    let text = '';
    let reasoning = '';
    const toolCalls = [];
    if (!Array.isArray(output))
        return {};
    for (const item of output) {
        if (!item || typeof item !== 'object')
            continue;
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c?.type === 'output_text' && typeof c.text === 'string')
                    text += c.text;
            }
        }
        else if (item.type === 'reasoning' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (typeof c?.text === 'string')
                    reasoning += c.text;
            }
        }
        else if (item.type === 'function_call') {
            const fn = item;
            let parsedInput = fn.arguments;
            if (typeof fn.arguments === 'string') {
                try {
                    parsedInput = JSON.parse(fn.arguments);
                }
                catch {
                    parsedInput = fn.arguments;
                }
            }
            toolCalls.push({
                callId: typeof fn.callId === 'string' ? fn.callId : '',
                name: typeof fn.name === 'string' ? fn.name : '',
                input: parsedInput,
            });
        }
    }
    const result = {};
    if (text.length > 0)
        result.text = text;
    if (reasoning.length > 0)
        result.reasoning = reasoning;
    if (toolCalls.length > 0)
        result.toolCalls = toolCalls;
    return result;
}
/**
 * Project the OR SDK's {@link Usage} shape down to the compact
 * {@link TranscriptUsage} the transcript log persists. Returns `undefined` for
 * a missing usage object so the record skips the field entirely (vs. writing
 * a zero-everywhere placeholder).
 */
function toTranscriptUsage(u) {
    if (!u || typeof u !== 'object')
        return undefined;
    const usage = u;
    const result = {
        prompt: usage.inputTokens ?? 0,
        completion: usage.outputTokens ?? 0,
    };
    if (usage.outputTokensDetails?.reasoningTokens !== undefined) {
        result.reasoning = usage.outputTokensDetails.reasoningTokens;
    }
    if (usage.inputTokensDetails?.cachedTokens !== undefined) {
        result.cached = usage.inputTokensDetails.cachedTokens;
    }
    return result;
}
function deriveCompletionStatus(input) {
    if (input.totalCostUsd >= input.maxBudgetUsd)
        return 'max_budget';
    // Turn numbers are 0-indexed (turn 0 = initial request). stepCountIs(n)
    // stops when the *step count* (1-indexed) reaches n, i.e. when turnNumber
    // hits n - 1. Treating "max turnNumber observed + 1 >= maxTurns" as the
    // step-count threshold matches that.
    if (input.maxTurnNumber + 1 >= input.maxTurns)
        return 'max_turns';
    return 'success';
}
//# sourceMappingURL=agent.js.map