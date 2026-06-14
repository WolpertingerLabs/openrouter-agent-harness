import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isTurnStartEvent,
  isTurnEndEvent,
  isToolCallOutputEvent,
  isClientTool,
  type Tool,
  type StateAccessor,
  type ConversationState,
} from '@openrouter/agent';
import type { AnthropicCacheControlDirective, ResponsesRequest } from '@openrouter/sdk/models';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CHARS_PER_TOKEN,
  COMPACTION_PROMPT,
  DEFAULT_KEEP_RECENT_TURNS,
  partitionMessages,
  resolveCompactionThresholdChars,
  resolveCompactionThresholdTokens,
  serializeMessagesForEstimate,
} from './compaction.js';
import { StreamStallError, createStallMonitor, monitorStream, type StallMonitor } from './stall.js';
import { allTools } from './tools/index.js';
import {
  createSkillLoader,
  type SkillLoader,
  type SkillInfo,
  type SubstitutionContext,
} from './skills/index.js';
import {
  DEFAULT_SKILL_DESCRIPTION_BUDGET,
  buildSkillListing,
  type ActiveSkillContext,
} from './tools/skill.js';
import {
  createServerToolsHooks,
  DEFAULT_SERVER_TOOLS,
  type ServerToolConfig,
} from './tools/server-tools.js';
import { isServerToolOutputItem, normalizeServerToolItem } from './tools/server-tool-items.js';
import { type ToolContext } from './tools/context.js';
import type { OnAskUserQuestion } from './tools/ask-user-question.js';
import type { OnTasksChanged, TaskListRef } from './tools/tasks.js';
import { createFileStateAccessor } from './state/file-state.js';
import { createMemoryStateAccessor } from './state/memory-state.js';
import {
  createRequestId,
  createGenerationId,
  logRequest,
  logGeneration,
  logSessionStart,
} from './logging/logger.js';
import {
  logTranscriptSessionStart,
  logTranscriptUser,
  logTranscriptAssistant,
  logTranscriptToolResult,
  logTranscriptServerTool,
  logTranscriptCompact,
  logTranscriptSessionEnd,
  type TranscriptToolCall,
  type TranscriptUsage,
} from './logging/transcript.js';
import type {
  AgentCoreEvent,
  AgentCoreEventStatus,
  HookEvent,
  HookPayload,
  PreToolUseAction,
  TokenUsage,
} from './events.js';
import { permissionModeToCanUseTool, type PermissionMode } from './permission-modes.js';
import { buildToolFilterCanUseTool, compileRule } from './tool-filters.js';
import { composeInstructions, type SettingSource } from './context-discovery.js';
import { aggregateMessages, type AgentMessage } from './messages.js';
import { forkSession, type ForkSessionResult } from './session-fork.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_PARALLEL_SUBAGENTS,
  type SubagentRunner,
  type SubagentRunResult,
} from './tools/spawn-subagent.js';
import { McpBridge, MCP_TOOL_NAME_SEPARATOR } from './mcp/bridge.js';
import { loadMcpConfig, type McpServerConfig } from './mcp/config.js';
import type { LoadedPlugin } from './plugins/index.js';
import {
  createRouteCache,
  isPseudoModel,
  resolveRoute,
  resolveRouteCached,
  routeCacheKey,
  type RouteResolution,
  type RouterPlugin,
  type RoutingContext,
} from './router.js';
import {
  StreamingInputSource,
  commitPartialResponse,
  isAsyncIterable,
  setInterruptedFlag,
  userInputToCallModelItem,
  type UserInput,
} from './streaming-input.js';

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
export const DEFAULT_INSTRUCTIONS =
  'You are a code editing agent. You can read, write, and edit files, list directories, and run shell commands. Work step by step: read files to understand the codebase, then make changes. Always verify your changes.';

export type AgentLoggerLevel = 'debug' | 'info' | 'warn' | 'error';
export type AgentLogger = (
  level: AgentLoggerLevel,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type CanUseToolResult =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; reason: string };

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

export type CanUseTool = (
  toolName: string,
  input: unknown,
  ctx: CanUseToolContext,
) => Promise<CanUseToolResult> | CanUseToolResult;

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
export type OnHook = (
  event: HookEvent,
  payload: HookPayload,
) => void | PreToolUseAction | Promise<void | PreToolUseAction>;

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
   * code is `server_error` / `overloaded`, an HTTP 5xx error from the SDK,
   * a hung stream ({@link streamStallTimeoutMs}), or an EMPTY completed
   * response ({@link EmptyModelResponseError}: the final response carried no
   * text, reasoning, tool calls, or server-tool output — a blank 200 some
   * providers return instead of a proper error). Deterministic failures
   * (4xx-class errors, moderation blocks, context overflow) and
   * abort/interrupt paths are never retried.
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
   * OpenRouter server-side tools to inject into every request body (the main
   * cycle AND the compaction pass). Each entry is forwarded verbatim, so any
   * valid per-tool configuration the caller wants rides along — e.g.
   * `{ type: 'openrouter:web_search', engine: 'exa', max_results: 5 }` or a
   * `web_fetch` with custom limits.
   *
   * - **Omitted** → the three {@link DEFAULT_SERVER_TOOLS} (datetime,
   *   web_search, web_fetch) with default parameters, preserving prior behavior.
   * - **`[]`** → no server tools, and the body-rewriting hook is not registered
   *   at all. Use this when OR's `cacheControl` auto-prompt-caching must stay
   *   intact: empirically the server-tools rewrite invalidates the cache-key
   *   path OR uses to forward to Anthropic when user-defined tools are present.
   * - **Custom array** → exactly those tools, replacing the defaults.
   *
   * Inherited by spawned subagents unless the spawn config overrides. Applies
   * to both the main run client and the compaction client (which share
   * `createOpenRouterClient`).
   */
  serverTools?: readonly ServerToolConfig[];
  /**
   * Extra OpenRouter request-body parameters, shallow-merged into every
   * `callModel` request body (the main cycle AND the compaction pass), and
   * inherited verbatim by spawned subagents. This is the escape hatch for
   * model/provider knobs the harness does not surface a dedicated option for —
   * sampling (`temperature`, `topP`, `topK`, `frequencyPenalty`,
   * `presencePenalty`, `maxOutputTokens`), `provider` routing preferences, and
   * OR `plugins`.
   *
   * Typed as `Partial<ResponsesRequest>` deliberately: `callModel` runs the
   * request through the SDK's Zod schema, which (a) STRIPS any key not declared
   * on `ResponsesRequest` and (b) expects **camelCase** field names, remapping
   * them to snake_case on the wire (`topP` → `top_p`). An untyped bag would let
   * snake_case or misspelled keys be silently dropped — the `Partial` type
   * catches that at compile time.
   *
   * The canonical plugin example is selecting a coding tier on
   * `openrouter/pareto` via the `pareto-router` plugin's `minCodingScore` (0–1,
   * higher → stronger but pricier model; omitted → the router's High tier):
   *
   * ```ts
   * modelParams: {
   *   temperature: 0.2,
   *   plugins: [{ id: 'pareto-router', minCodingScore: 0.5 }],
   * }
   * ```
   *
   * Merge semantics: these keys are spread FIRST, so any field the harness sets
   * structurally — `model`, `input`, `instructions`, `tools`, `state`,
   * `stopWhen`, `include`, `onTurnEnd`, and the {@link effort}/{@link cacheControl}
   * options — always wins on conflict. Use {@link effort}/{@link cacheControl}
   * for reasoning depth and prompt caching rather than re-specifying them here.
   * Omitted runs send no extra fields, preserving default behavior.
   */
  modelParams?: Partial<ResponsesRequest>;
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
  /**
   * In-memory router plugins (autorouters / pseudomodels). Each
   * {@link RouterPlugin} claims one or more fake model IDs (e.g. `auto/coding`)
   * and resolves them to a concrete model just before a request is dispatched.
   * See `plans/autorouter-pseudomodels.md` and {@link RouterPlugin}.
   *
   * Lifecycle: every router's {@link RouterPlugin.init} (when present) fires
   * once after the `Setup` hook and before the first `callModel`; the matching
   * {@link RouterPlugin.dispose} fires once in the run's `finally`. An `init`
   * that throws is non-fatal — the run continues and that router still gets a
   * paired `dispose`. Defaults to an empty array.
   */
  routers?: readonly RouterPlugin[];
}

interface ResolvedOptions {
  apiKey: string;
  sessionId: string;
  prompt: string | AsyncIterable<UserInput>;
  instructions: string;
  model: string;
  cwd: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * Resolved retry budget for transient terminal cycle failures (defaulted
   * to {@link DEFAULT_MAX_TRANSIENT_RETRIES}). Consumed by the per-cycle
   * retry loop in {@link OpenRouterAgentRun.iterate} and inherited by
   * spawned subagents.
   */
  maxTransientRetries: number;
  /**
   * Resolved exponential-backoff base (ms) between transient-failure retries
   * (defaulted to {@link DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS}). Inherited
   * by spawned subagents alongside {@link maxTransientRetries}.
   */
  transientRetryBaseDelayMs: number;
  /**
   * Resolved hung-stream threshold (ms; `0` = disabled), defaulted to
   * {@link DEFAULT_STREAM_STALL_TIMEOUT_MS}. One {@link StallMonitor} is
   * created per cycle ATTEMPT in {@link OpenRouterAgentRun.iterate} and
   * disposed in the cycle's finally. Inherited by spawned subagents.
   */
  streamStallTimeoutMs: number;
  /**
   * Resolved per-tool execute deadline (ms; `0` = disabled), defaulted to
   * {@link DEFAULT_TOOL_TIMEOUT_MS}. Applied as the INNERMOST tool wrapper
   * (exempt: `bash`, `spawn_subagent`/`spawn_subagents`, `ask_user_question`,
   * `monitor`, `skill`, MCP-bridged tools). Inherited by spawned subagents.
   */
  toolTimeoutMs: number;
  tools: readonly Tool[];
  appTitle: string;
  logsRoot: string;
  canUseTool?: CanUseTool;
  onHook?: OnHook;
  onAskUserQuestion?: OnAskUserQuestion;
  onTasksChanged?: OnTasksChanged;
  signal?: AbortSignal;
  baseUrl?: string;
  logger?: AgentLogger;
  settingSources: readonly SettingSource[];
  persistSession: boolean;
  checkpoint: boolean;
  parentSessionId?: string;
  enableSubagents: boolean;
  maxSubagentDepth: number;
  currentSubagentDepth: number;
  maxParallelSubagents: number;
  /**
   * Phase 4.8: preserved here so the subagent runner can inherit the parent's
   * already-resolved `permissionMode` when a spawn call omits its own
   * override. The composed {@link canUseTool} is what actually gates the
   * parent's own tool calls — this field is only the inheritance source for
   * children.
   */
  permissionMode?: PermissionMode;
  /** Phase 4.8: same as {@link permissionMode}, but for `allowedTools`. */
  allowedTools?: readonly string[];
  /** Phase 4.8: same as {@link permissionMode}, but for `disallowedTools`. */
  disallowedTools?: readonly string[];
  /**
   * Phase 5.4: resolved per-run effort override. Forwarded into the OR
   * `callModel` call as `reasoning: { effort }` ONLY when defined (omitted →
   * no `reasoning` field in the request body), and inherited by spawned
   * subagents when their spec omits an override.
   */
  effort?: EffortLevel;
  /**
   * Resolved per-run OR auto-prompt-cache directive. Forwarded into the
   * `callModel` call as `cacheControl` ONLY when defined (omitted → no
   * `cacheControl` field on the wire), and inherited by spawned subagents
   * when their spec omits an override. Mirrors the {@link effort} resolution
   * shape; thin passthrough — no defaulting, no shape munging.
   */
  cacheControl?: AnthropicCacheControlDirective;
  /**
   * Resolved per-run server-tool list. When omitted, `createOpenRouterClient`
   * falls back to {@link DEFAULT_SERVER_TOOLS}; an empty array suppresses the
   * injection hook entirely (preserving OR's `cacheControl` auto-caching).
   * Forwarded verbatim into `createServerToolsHooks`, and inherited by spawned
   * subagents when their spec omits an override. Mirrors the
   * {@link cacheControl} resolution shape.
   */
  serverTools?: readonly ServerToolConfig[];
  /**
   * Resolved per-run extra request-body passthrough (`Partial<ResponsesRequest>`:
   * sampling params, `provider`, OR `plugins`, …). Shallow-merged into the main
   * and compaction `callModel` request bodies (harness-set fields win on
   * conflict; see the input-option JSDoc), and inherited by spawned subagents
   * verbatim. Thin passthrough — no defaulting, no shape munging.
   */
  modelParams?: Partial<ResponsesRequest>;
  /**
   * Phase 5.1: explicit caller-supplied threshold (chars — or TOKENS when
   * {@link tokenCounter} is set). `undefined` → derived from {@link model}.
   */
  compactionThreshold?: number;
  /**
   * Resolved per-run context-window override table, merged over the static
   * {@link MODEL_CONTEXT_WINDOWS} at lookup time (override exact → override
   * alias → static exact → static alias → default). Inherited by spawned
   * subagents. Mirrors the {@link cacheControl} resolution shape.
   */
  modelContextWindows?: Readonly<Record<string, number>>;
  /**
   * Resolved tokenizer hook for the auto-compaction estimate. When set, the
   * threshold check compares real token counts against a TOKEN threshold
   * instead of the chars/4 heuristic; a throw falls back to chars for that
   * check. Inherited by spawned subagents.
   */
  tokenCounter?: (serializedMessages: string) => number;
  /** Phase 5.1: resolved trailing-message count to preserve verbatim. */
  keepRecentTurns: number;
  /** Phase 5.1: resolved auto-trigger toggle. */
  autoCompact: boolean;
  /** Phase 5.2.4: explicit MCP server list (overrides discovery when set). */
  mcpServers?: readonly McpServerConfig[];
  /** Phase 5.2.4: resolved discovery toggle (defaults to `false`). */
  autoDiscoverMcp: boolean;
  /** Phase 5.5: resolved tool-search opt-in (defaults to `false`). */
  enableToolSearch: boolean;
  /** Phase 5.7: resolved skill loader (or undefined when skills are not configured). */
  skills?: SkillLoader;
  /** Phase 5.7: resolved budget fraction for the listing block. */
  skillDescriptionBudget: number;
  /** Phase 5.7: resolved shell-exec policy flag. */
  disableSkillShellExecution: boolean;
  /** Phase 5.7: resolved env passthrough for skill substitution. */
  skillEnv: Readonly<Record<string, string>>;
  /** Phase 5.8: resolved plugin contributions (empty array when none supplied). */
  plugins: readonly LoadedPlugin[];
  /** Resolved in-memory router plugins (empty array when none supplied). */
  routers: readonly RouterPlugin[];
}

function resolveOptions(opts: OpenRouterAgentRunOptions): ResolvedOptions {
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
  const sources: string[] = [];
  if (opts.canUseTool !== undefined) sources.push('canUseTool');
  if (opts.permissionMode !== undefined) sources.push('permissionMode');
  if (filterListsSet) sources.push('allowedTools/disallowedTools');

  let canUseTool: CanUseTool | undefined;
  if (opts.canUseTool !== undefined) {
    canUseTool = opts.canUseTool;
    if (sources.length > 1) {
      opts.logger?.(
        'warn',
        'Explicit canUseTool was supplied alongside higher-level permission options (permissionMode, allowedTools/disallowedTools); canUseTool wins and the others are ignored',
        { permissionMode: opts.permissionMode, sources },
      );
    }
  } else if (filterListsSet) {
    const modeGate =
      opts.permissionMode !== undefined
        ? permissionModeToCanUseTool(opts.permissionMode)
        : undefined;
    canUseTool = buildToolFilterCanUseTool({
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      modeGate,
    });
  } else if (opts.permissionMode !== undefined) {
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
    transientRetryBaseDelayMs:
      opts.transientRetryBaseDelayMs ?? DEFAULT_TRANSIENT_RETRY_BASE_DELAY_MS,
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
    ...(opts.serverTools !== undefined && { serverTools: opts.serverTools }),
    ...(opts.modelParams !== undefined && { modelParams: opts.modelParams }),
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
    routers: opts.routers ?? [],
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
function resolveSkillLoader(
  opts: OpenRouterAgentRunOptions,
  cwd: string,
  plugins: readonly LoadedPlugin[],
): SkillLoader | undefined {
  if (opts.skills !== undefined) {
    if (plugins.length > 0) {
      opts.logger?.(
        'warn',
        'plugins supplied alongside a pre-built skills loader — plugin skill roots will not be auto-wired; pass the plugin pluginRoots into the loader yourself',
        { pluginCount: plugins.length },
      );
    }
    return opts.skills;
  }
  if (opts.skillsDir !== undefined || plugins.length > 0) {
    const pluginRoots: Array<{ name: string; root: string; skillsDir?: string }> = [];
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
 * The concrete model (plus any per-route param overrides) the compaction pass
 * should run against, as returned by
 * {@link OpenRouterAgentRun.resolveCompactionModel}. Passed from the
 * auto-compaction trigger into {@link OpenRouterAgentRun.compact} so the
 * compaction route is consulted exactly once per run.
 */
interface ResolvedCompactionModel {
  model: string;
  modelParams?: Record<string, unknown>;
  /**
   * The `router_decision` event for this compaction resolution, present only
   * when the run's `model` was a pseudomodel that a router claimed. The
   * auto-compaction trigger yields this from {@link OpenRouterAgentRun.iterate}'s
   * `finally` so consumers observe which model compaction routed to.
   */
  decision?: Extract<AgentCoreEvent, { type: 'router_decision' }>;
}

/**
 * Single-shot async iterable that drives an OpenRouter agent turn-by-turn and
 * yields normalized {@link AgentCoreEvent}s. One instance per query. Construct,
 * `for await` the events, done.
 */
export class OpenRouterAgentRun implements AsyncIterable<AgentCoreEvent> {
  private readonly opts: ResolvedOptions;
  private readonly internalAbortController = new AbortController();
  private readonly compositeSignal: AbortSignal;
  /** True when caller supplied a custom `tools` array (signal not auto-wrapped). */
  private readonly hasCustomTools: boolean;
  /**
   * Shared task list both `task_create` / `task_update` factories mutate.
   * Ephemeral per run — never persisted to `state.json`. Survives across
   * turns inside this run instance.
   */
  private readonly taskListRef: TaskListRef = { tasks: [] };
  /**
   * Snapshot of `persistSession` captured at construction. Used by
   * {@link fork} to short-circuit the in-memory rejection path without
   * touching the filesystem (and without exposing the full resolved-opts
   * struct on the instance).
   */
  private readonly persistSession: boolean;
  /**
   * Phase 5.1: state accessor created once at construction so the public
   * {@link compact} method can read/write the persisted
   * {@link ConversationState} without depending on whether {@link iterate}
   * has been driven yet. File-backed when `persistSession !== false`,
   * otherwise an in-memory mirror sharing the same load/save contract.
   */
  private readonly stateAccessor: StateAccessor;
  private consumed = false;
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
  #mcpBridge?: McpBridge;
  /**
   * Phase 5.3: streaming-input source — wraps the constructor `prompt`
   * (`string | AsyncIterable<UserInput>`) and the imperative
   * {@link pushUserMessage} queue behind a single `next()` interface that the
   * multi-turn restart loop drains. Constructed eagerly so
   * {@link pushUserMessage} works from the moment the run object exists
   * (callers commonly wire a UI listener that pushes before/during the
   * `for await` consumer loop).
   */
  readonly #inputSource: StreamingInputSource;
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
  #currentCycle: Promise<void> | undefined;

  constructor(options: OpenRouterAgentRunOptions) {
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
    if (typeof options.prompt !== 'string' && !isAsyncIterable<UserInput>(options.prompt)) {
      throw new Error(
        'prompt must be a string or an AsyncIterable<UserInput> (Phase 5.3 streaming input).',
      );
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
  pushUserMessage(msg: UserInput | string): Promise<void> {
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
  async interrupt(): Promise<void> {
    await setInterruptedFlag(this.stateAccessor, 'host-interrupt');
    if (this.#currentCycle) {
      try {
        await this.#currentCycle;
      } catch {
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
  private createOpenRouterClient(): OpenRouter {
    // Omitted → default trio; explicit `[]` → no hook at all (the body rewrite
    // itself, not just the tools it adds, is what invalidates OR's cacheControl
    // path, so an empty-but-registered hook would defeat the caching opt-out).
    const serverTools = this.opts.serverTools ?? DEFAULT_SERVER_TOOLS;
    return new OpenRouter({
      apiKey: this.opts.apiKey,
      ...(this.opts.baseUrl && { serverURL: this.opts.baseUrl }),
      appTitle: this.opts.appTitle,
      ...(serverTools.length > 0 && { hooks: createServerToolsHooks(serverTools) }),
    } as ConstructorParameters<typeof OpenRouter>[0]);
  }

  /**
   * Invoke the run's `onHook` handler with the given event/payload, returning
   * the handler's raw return value (or `undefined` when no handler is set or
   * the handler throws). Throws are logged via {@link AgentLogger} and
   * swallowed — never re-raised — so a handler cannot break the run. Used
   * by both {@link iterate} (via a thin local closure that forwards into
   * here) and {@link compact} (directly).
   */
  private async safeFireHook(event: HookEvent, payload: HookPayload): Promise<unknown> {
    const { onHook, logger } = this.opts;
    if (!onHook) return undefined;
    try {
      return await onHook(event, payload);
    } catch (err) {
      logger?.('error', 'Hook threw', { event, error: err });
      return undefined;
    }
  }

  /**
   * Resolve the concrete model the compaction pass should run against. When the
   * run's `model` is a pseudomodel (some configured router claims it), run the
   * resolution engine with `phase: 'compaction'` so the summarizer can ride a
   * different (e.g. cheaper) model than the main turn — and, critically, so the
   * context-window math in {@link isOverCompactionThreshold} sizes against the
   * RESOLVED real model rather than silently falling to the 128k default.
   * Otherwise the run's `model` passes through verbatim.
   *
   * Resolves fresh (no stickiness cache): compaction fires at most once per run
   * boundary, so there is nothing to amortize, and the per-turn route cache is
   * scoped to {@link iterate}. Routing is fail-safe inside the engine, so this
   * never throws — a router failure falls back to {@link DEFAULT_MODEL}.
   */
  private async resolveCompactionModel(
    messages: readonly unknown[],
  ): Promise<ResolvedCompactionModel> {
    const { model, routers, sessionId, logger } = this.opts;
    if (routers.length === 0) return { model };
    const serialized = serializeMessagesForEstimate(messages);
    const routingCtx: RoutingContext = {
      pseudoModel: model,
      // Fail-safe fallback must be a real model — when `model` is the
      // pseudomodel it can't double as its own default.
      defaultModel: DEFAULT_MODEL,
      sessionId,
      turn: 0,
      phase: 'compaction',
      messages,
      input: messages,
      instructions: COMPACTION_PROMPT,
      // The compaction sub-call runs without client tools.
      tools: [],
      estimatedTokens: Math.ceil(serialized.length / CHARS_PER_TOKEN),
    };
    const resolution = await resolveRoute(model, routingCtx, routers, logger);
    if (!resolution) return { model };
    return {
      model: resolution.resolvedModel,
      ...(resolution.modelParams !== undefined && { modelParams: resolution.modelParams }),
      decision: buildRouterDecisionEvent(model, 0, 'compaction', resolution),
    };
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
  async compact(
    reason: 'auto' | 'manual' = 'manual',
    preResolved?: ResolvedCompactionModel,
  ): Promise<void> {
    if (this.#isIterating) {
      throw new Error(
        'Cannot call compact() while iterate() is in progress — see the Mid-run safety note in the README.',
      );
    }
    const state = await this.stateAccessor.load();
    if (!state) return;
    const rawMessages = (state as { messages?: unknown }).messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;
    const { summarize, keep } = partitionMessages(rawMessages, this.opts.keepRecentTurns);
    if (summarize.length === 0) return;

    await this.safeFireHook('PreCompact', {
      event: 'PreCompact',
      messages: summarize,
      keepRecentTurns: this.opts.keepRecentTurns,
      reason,
    });

    // Resolve the (possibly pseudo-) model with `phase: 'compaction'` so the
    // summarizer can ride a different model than the main turn. The auto-trigger
    // already resolved it (to size the threshold) and threads the decision in
    // via `preResolved`; a manual `compact()` resolves here.
    const { model: compactionModel, modelParams: compactionParams } =
      preResolved ?? (await this.resolveCompactionModel(rawMessages));

    const client = this.createOpenRouterClient();
    const compactSessionId = `${this.opts.sessionId}:compact:${randomUUID()}`;
    const result = client.callModel({
      // Same passthrough as the main cycle; spread first so the structural
      // fields and `cacheControl` below win on conflict. Per-route
      // `modelParams` from the compaction route layer over the run-level
      // passthrough (route wins) but still below the structural fields.
      ...this.opts.modelParams,
      ...compactionParams,
      model: compactionModel,
      sessionId: compactSessionId,
      input: JSON.stringify(summarize),
      instructions: COMPACTION_PROMPT,
      // Compaction prompts are exactly the kind of large reusable prefix that
      // benefits from auto prompt caching. Inherit the run's `cacheControl`
      // when set; omit when unset (preserves prior behavior).
      ...(this.opts.cacheControl !== undefined && {
        cacheControl: this.opts.cacheControl,
      }),
    } as Parameters<typeof client.callModel>[0]);

    let summaryText = '';
    for await (const event of result.getFullResponsesStream()) {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        (event as { type: unknown }).type === 'response.output_text.delta'
      ) {
        const delta = (event as { delta?: unknown }).delta;
        if (typeof delta === 'string') summaryText += delta;
      }
    }

    const summaryMessage = {
      type: 'message' as const,
      role: 'developer' as const,
      content: `[Compacted prior context]\n${summaryText}`,
    };

    const nextState: ConversationState = {
      ...state,
      messages: [summaryMessage, ...keep] as ConversationState['messages'],
      updatedAt: Date.now(),
    };
    // The SDK uses `undefined` to mean "absent" for these optional fields;
    // deleting them keeps the on-disk JSON tidy and lets a re-load via the
    // accessor yield the same shape the SDK would build from scratch.
    delete (nextState as { previousResponseId?: unknown }).previousResponseId;
    delete (nextState as { pendingToolCalls?: unknown }).pendingToolCalls;
    delete (nextState as { unsentToolResults?: unknown }).unsentToolResults;
    delete (nextState as { partialResponse?: unknown }).partialResponse;

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
   *   tokens), else `floor(getModelContextWindow(windowModel,
   *   modelContextWindows) * DEFAULT_THRESHOLD_RATIO)`. A throwing counter logs
   *   a `'warn'` and falls through to char mode for this check — a tokenizer
   *   bug must never kill a run that was otherwise healthy.
   * - **Char mode** (default) — serialized length vs.
   *   {@link resolveCompactionThresholdChars} (the v1 chars/4 heuristic),
   *   with the same per-run {@link OpenRouterAgentRunOptions.modelContextWindows}
   *   overrides applied to the window lookup.
   *
   * `windowModel` is the RESOLVED concrete model (see
   * {@link resolveCompactionModel}); the window lookup must key on a real model,
   * not a pseudomodel that would silently fall to the 128k default.
   */
  private isOverCompactionThreshold(messages: unknown, windowModel: string): boolean {
    const { tokenCounter, compactionThreshold, modelContextWindows, logger } = this.opts;
    const serialized = serializeMessagesForEstimate(messages);
    if (tokenCounter !== undefined) {
      try {
        const tokens = tokenCounter(serialized);
        const thresholdTokens = resolveCompactionThresholdTokens(
          compactionThreshold,
          windowModel,
          modelContextWindows,
        );
        return tokens >= thresholdTokens;
      } catch (err) {
        logger?.('warn', 'tokenCounter threw — falling back to the chars/4 heuristic', {
          error: err,
        });
      }
    }
    const thresholdChars = resolveCompactionThresholdChars(
      compactionThreshold,
      windowModel,
      modelContextWindows,
    );
    return serialized.length >= thresholdChars;
  }

  /**
   * Abort the in-flight run. Fires the run's internal AbortController, which
   * triggers cancellation of the OR stream and any in-flight tool execution.
   * Idempotent — safe to call multiple times. Calling before the iterator is
   * consumed causes the first yielded event to be a `stream_complete` with
   * `reason: 'aborted'` (no `session_started`).
   */
  abort(): void {
    if (!this.internalAbortController.signal.aborted) {
      this.internalAbortController.abort();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentCoreEvent> {
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
  messages(): AsyncIterable<AgentMessage> {
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
  fork(opts: { newSessionId?: string } = {}): Promise<ForkSessionResult> {
    if (!this.persistSession) {
      return Promise.reject(
        new Error(
          `cannot fork in-memory session: ${this.opts.sessionId} has no on-disk state at ${join(this.opts.logsRoot, this.opts.sessionId, 'state.json')}`,
        ),
      );
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
  private async resolveMcpServers(): Promise<readonly McpServerConfig[]> {
    let base: readonly McpServerConfig[];
    if (this.opts.mcpServers !== undefined) {
      base = this.opts.mcpServers;
    } else if (!this.opts.autoDiscoverMcp) {
      base = [];
    } else {
      try {
        base = await loadMcpConfig({ cwd: this.opts.cwd });
      } catch (err) {
        this.opts.logger?.('warn', 'MCP discovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        base = [];
      }
    }
    if (this.opts.plugins.length === 0) return base;
    const fromPlugins = this.opts.plugins.flatMap((p) => p.mcpServers);
    return [...base, ...fromPlugins];
  }

  private async *iterate(): AsyncGenerator<AgentCoreEvent> {
    const {
      apiKey,
      sessionId,
      instructions: baseInstructions,
      model,
      cwd,
      maxTurns,
      maxBudgetUsd,
      maxTransientRetries,
      transientRetryBaseDelayMs,
      tools: userTools,
      appTitle,
      logsRoot,
      baseUrl,
      logger,
      onHook,
      settingSources,
      persistSession,
      onAskUserQuestion,
      onTasksChanged,
      parentSessionId,
    } = this.opts;
    // Discovery happens here (not in resolveOptions) so the constructor stays
    // synchronous and the public API shape is unchanged. When settingSources
    // is empty, composeInstructions short-circuits without any FS reads.
    const composedInstructions =
      settingSources.length > 0
        ? await composeInstructions({ cwd, settingSources, instructions: baseInstructions, logger })
        : baseInstructions;
    // Phase 5.7: discover skills (if a loader is configured) and append a
    // `## Available Skills` block to the instructions within the configured
    // budget. Skills dropped from the listing remain callable by exact name.
    const skillsForRun = this.opts.skills ? await this.opts.skills.list() : [];
    const skillVisibleNames: string[] = [];
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
          if (m && m[1] !== undefined) skillVisibleNames.push(m[1]);
        }
      } else {
        // Listing was empty (every skill had disable-model-invocation or the
        // budget was tighter than the smallest entry). Keep skillsForRun
        // around so the tool can still be invoked by exact name.
      }
    }

    const startMs = Date.now();
    let maxTurnNumber = 0;
    let totalCostUsd = 0;
    let finalUsage: TokenUsage | null = null;
    // Tool call_id → tool_name, populated when the SDK emits a function_call
    // item and read when the matching tool_call_output arrives. The output
    // event carries only the callId, so a side-map is the cheapest way to
    // surface the human-readable name on the transcript record.
    const toolCallNames = new Map<string, string>();
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
    let sessionEndPayload: Extract<HookPayload, { event: 'SessionEnd' }> | null = null;
    // Mirrors sessionEndPayload but for the trailing Stop hook. Stop fires
    // last regardless of completion status; reason is populated on abort or
    // thrown-error paths so subscribers can distinguish clean from dirty exit.
    let stopPayload: Extract<HookPayload, { event: 'Stop' }> = { event: 'Stop', status: 'error' };
    // Hoisted so the `finally` block can gate the auto-compact trigger on
    // it. Default 'error' covers any path that exits iterate() without
    // explicitly setting it (pre-abort short-circuit, OR-ctor throw, mid-
    // stream throw, abort). The happy-path arm assigns the result of
    // {@link deriveCompletionStatus}.
    let status: AgentCoreEventStatus = 'error';
    // Captured when a `response.failed` event flows through the SDK
    // broadcaster. We intentionally do NOT throw from inside the for-await
    // loop because that would close the SDK generator (via `iter.return()`)
    // before it reaches its terminal `await executionPromise;` — orphaning
    // the chained promise created by `startTurnBroadcasterExecution`'s
    // `.finally()` and surfacing as an `unhandledRejection` that kills the
    // host process. Holding the event here lets the catch arm convert it to
    // the pretty-printed reason via {@link extractResponseFailedMessage}.
    let pendingFailedEvent: unknown = null;
    // Holds the compaction-phase `router_decision` event produced by the
    // auto-compaction trigger in the `finally` below. Yielded as the very last
    // statement of `finally` (after the Stop hook) so it never suspends the
    // cleanup bracket on an early-`break` consumer's `return()`, yet is still
    // delivered to consumers that drain the stream to completion. `undefined`
    // unless the run's `model` is a pseudomodel and auto-compaction resolved it.
    let pendingCompactionDecision:
      | Extract<AgentCoreEvent, { type: 'router_decision' }>
      | undefined;

    this.#isIterating = true;

    // Phase 5.8: per-plugin start timestamps so `PluginStop` can report the
    // elapsed lifetime. Populated as each `PluginStart` fires below; drained
    // in the outer `finally`. Empty Map when no plugins are configured.
    const pluginStartTimes = new Map<string, number>();
    // Phase 5.8: lookup table consumed by the skill tool's `buildContext`
    // closure when an active plugin-sourced skill renders — built once here
    // so the closure body is a single Map.get call. Empty Map when no
    // plugins are configured (the closure short-circuits via the
    // `skill.pluginName` truthy check).
    const pluginByName = new Map(this.opts.plugins.map((p) => [p.manifest.name, p]));

    // Routers (autorouters / pseudomodels): every router that reaches the init
    // phase below is recorded here so the outer `finally` can fire its paired
    // `dispose` exactly once. Empty when no routers are configured, or when the
    // run aborts at construction before the init loop runs (no lifecycle to
    // bracket — mirrors the `pluginStartTimes` skip semantics).
    const initializedRouters: RouterPlugin[] = [];

    // Thin forwarder around the class-level safeFireHook so the existing
    // closures in this generator (subagent lifecycle emitters,
    // wrapToolWithHooks plumbing, etc.) keep their original call signature.
    // The class-level method exists so {@link compact} can fire PreCompact
    // outside this generator without duplicating the try/catch.
    const safeFireHook = (event: HookEvent, payload: HookPayload): Promise<unknown> =>
      this.safeFireHook(event, payload);

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
    let resultHandle: { cancel(): Promise<void>; getResponse(): Promise<unknown> } | undefined;
    const onAbort = (): void => {
      if (resultHandle) void resultHandle.cancel().catch(() => undefined);
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

      let client: OpenRouter;
      try {
        client = this.createOpenRouterClient();
      } catch (err) {
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
      const ctx: ToolContext = {
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
      const runSubagent: SubagentRunner = async (config) => {
        const childCtx: ToolContext = {
          cwd,
          signal: config.signal,
          sessionId: config.sessionId,
          logsRoot,
          checkpoint: this.opts.checkpoint,
          persistSession,
          ...(logger && { logger }),
        };
        const childTaskListRef: TaskListRef = { tasks: [] };
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
        const childTools =
          toolNames !== undefined
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
        const childServerTools = config.serverTools ?? this.opts.serverTools;
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
          ...(this.opts.modelParams !== undefined && { modelParams: this.opts.modelParams }),
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
          ...(childServerTools !== undefined && {
            serverTools: childServerTools,
          }),
        });
        let text = '';
        let summary: SubagentRunResult = {
          status: 'error',
          text: '',
          reason: 'subagent produced no stream_complete event',
        };
        for await (const ev of child) {
          if (ev.type === 'text_delta') {
            text += ev.content;
          } else if (ev.type === 'stream_complete') {
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
          notify: (level, message, context) =>
            safeFireHook('Notification', {
              event: 'Notification',
              level,
              message,
              context,
            }) as Promise<unknown> as Promise<void>,
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

      // Routers: warm up each router AFTER PluginStart and BEFORE the first
      // `callModel`. Recorded in `initializedRouters` before `init` is invoked
      // so the `finally` disposes it 1:1 even if `init` throws (an `init`
      // failure is non-fatal — logged at `warn`, the run continues, and the
      // router may still resolve at route time with whatever state it has).
      for (const router of this.opts.routers) {
        initializedRouters.push(router);
        if (!router.init) continue;
        try {
          await router.init({
            apiKey,
            ...(baseUrl !== undefined && { baseUrl }),
            defaultModel: model,
            ...(logger !== undefined && { logger }),
          });
        } catch (err) {
          logger?.('warn', 'Router init failed — continuing without warm-up', {
            router: router.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
      const loadedToolNames = new Set<string>();
      const toolsForRun: Tool[] = [];

      // Phase 5.7: per-skill active context. When the `skill` tool fires, it
      // installs an {@link ActiveSkillContext} via `setActiveSkill` so the
      // wrapped canUseTool below narrows the run-level permission rules to
      // the skill's `allowed-tools`. Disposed in the skill tool's `finally`.
      let activeSkill: ActiveSkillContext | undefined;
      const setActiveSkill = (cxt: ActiveSkillContext): (() => void) => {
        activeSkill = cxt;
        return () => {
          if (activeSkill === cxt) activeSkill = undefined;
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
      const composedCanUseTool: CanUseTool | undefined =
        baseCanUseTool || skillsForRun.length > 0
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
              if (baseCanUseTool) return baseCanUseTool(toolName, input, ctx);
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
      let activeStallMonitor: StallMonitor | undefined;
      const toolActivity = {
        begin: (): void => {
          toolsInFlight++;
        },
        end: (): void => {
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
      const wrapTool = (t: Tool): Tool => {
        let wrapped: Tool = wrapToolWithTimeout(t, this.opts.toolTimeoutMs);
        if (composedCanUseTool) {
          wrapped = wrapToolWithPermission(wrapped, composedCanUseTool);
        }
        if (onHook) {
          wrapped = wrapToolWithHooks(wrapped, safeFireHook, logger);
        }
        return wrapToolWithActivityTracker(wrapped, toolActivity);
      };

      const baseTools: readonly Tool[] = this.hasCustomTools
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
                isLoaded: (name: string) => loadedToolNames.has(name),
                onLoad: async (name: string, server: string) => {
                  // The factory's `isLoaded` guard already short-circuits
                  // already-loaded names before reaching onLoad, and the
                  // `getCatalog` source is the same one the factory checks
                  // for `notFound` — so an entry that passes both gates is
                  // guaranteed to exist in `bridgeTools` (catalog and tools
                  // are derived from the same bridge entries). The `find`
                  // therefore never returns undefined in practice; the
                  // non-null assertion documents that invariant.
                  const found = bridgeTools.find(
                    (t) => isClientTool(t) && t.function.name === name,
                  )!;
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
                buildContext: (args, skill): SubstitutionContext => {
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
                onSkillLoaded: async (skill: SkillInfo) => {
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
      const initialPool: readonly Tool[] = [...baseTools, ...initialBridgeTools];
      for (const t of initialPool) toolsForRun.push(wrapTool(t));

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
      let interruptedReason: string | undefined;
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
      let retryState: {
        attempt: number;
        requestId: string;
        input: ReturnType<typeof userInputToCallModelItem>[];
      } | null = null;

      // Router (autorouter / pseudomodel) state, scoped to this run. The cache
      // pins each `(pseudoModel, phase)` decision so a sticky route survives
      // across cycles (protects the upstream prompt cache + keeps cost
      // predictable); `previousModel` carries the concrete model that ran last
      // cycle into the next `RoutingContext` so a router can stay sticky on its
      // own terms; `cycleIndex` is the 0-based cycle counter surfaced as
      // `RoutingContext.turn` (a retry re-runs the same cycle, so it does NOT
      // advance the index). Empty/unused when no router claims the run's model.
      const routeCache = createRouteCache();
      let previousModel: string | undefined;
      let cycleIndex = -1;

      while (true) {
        let cycleRequestId: string;
        let cycleInput: ReturnType<typeof userInputToCallModelItem>[];
        if (retryState === null) {
          cycleIndex += 1;
          // 1. Pull the next user input. Drains the imperative
          //    pushUserMessage() queue first (FIFO), then the constructor
          //    AsyncIterable<UserInput> if one was supplied. Done when both
          //    are exhausted.
          const inputResult = await this.#inputSource.next();
          if (inputResult.done) break;
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
            } catch (err) {
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
          const cyclePromptForLog =
            typeof inputResult.value.content === 'string'
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
        } else {
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

        // 3b. Resolve the model just before dispatch. When the run's `model` is
        //     a pseudomodel (some configured router claims it), run the
        //     stickiness-aware resolution engine to substitute a concrete model
        //     and merge any per-route `modelParams`; otherwise the model passes
        //     through verbatim. Routing failures are fail-safe inside the engine
        //     (they fall back to a real default and never throw), so this block
        //     can never crash a cycle. `previousModel` is recorded for the next
        //     cycle's `RoutingContext` regardless of whether routing fired.
        let requestModel = model;
        let routedParams: Record<string, unknown> | undefined;
        if (isPseudoModel(model, this.opts.routers)) {
          const persisted = await this.stateAccessor.load();
          const rawMessages = (persisted as { messages?: unknown } | null)?.messages;
          const stateMessages = Array.isArray(rawMessages) ? rawMessages : [];
          const serialized = serializeMessagesForEstimate(stateMessages);
          const routingCtx: RoutingContext = {
            pseudoModel: model,
            // Fail-safe fallback must be a real model — the run's own `model` is
            // the pseudomodel here, so use the harness default.
            defaultModel: DEFAULT_MODEL,
            sessionId,
            turn: cycleIndex,
            phase: 'turn',
            messages: stateMessages,
            input: cycleInput,
            instructions,
            tools: toolsForRun.map((t) => (isClientTool(t) ? t.function.name : t.config.type)),
            estimatedTokens: Math.ceil(serialized.length / CHARS_PER_TOKEN),
            budgetRemainingUsd: Math.max(0, maxBudgetUsd - totalCostUsd),
            ...(previousModel !== undefined && { previousModel }),
          };
          // Probe the cache BEFORE resolving so we can tell a fresh resolution
          // (miss) from a replayed sticky decision (hit): a `router_decision`
          // event is emitted only on the cycle that actually routes, not on the
          // cycles where a pinned sticky model is reused.
          const freshResolution = !routeCache.has(routeCacheKey(model, 'turn'));
          const resolution = await resolveRouteCached(
            model,
            routingCtx,
            this.opts.routers,
            routeCache,
            logger,
          );
          if (resolution) {
            requestModel = resolution.resolvedModel;
            routedParams = resolution.modelParams;
            // Surface the resolution before this cycle's `callModel` (and thus
            // before its `turn_start`). A sticky route emits exactly one
            // `'turn'` event (its first cycle is the only miss); `sticky: false`
            // and fallbacks never cache, so every cycle is a miss and re-emits.
            if (freshResolution) {
              yield buildRouterDecisionEvent(model, cycleIndex, 'turn', resolution);
            }
          }
        }
        previousModel = requestModel;

        // 4. Fire the callModel for this cycle. The state accessor is
        //    shared across cycles so the SDK's resume path picks up the
        //    accumulated `messages` history automatically.
        const result = client.callModel({
          // Caller-supplied passthrough (sampling params, `provider`, OR
          // `plugins` like pareto's `minCodingScore`). Spread FIRST so every
          // structural field below — model/input/tools/state/stopWhen/include —
          // and the effort/cacheControl options win on key conflict. Per-route
          // `modelParams` from a router layer over the run-level passthrough
          // (route wins) but still below the structural fields.
          ...this.opts.modelParams,
          ...routedParams,
          model: requestModel,
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
            ({
              cacheControl: this.opts.cacheControl,
            } as { cacheControl?: AnthropicCacheControlDirective })),
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
        if (signal.aborted) void result.cancel().catch(() => undefined);

        // Expose a per-cycle promise that `interrupt()` can await so the
        // host has a clean "stopped before next turn" handle. Resolved in
        // the finally below regardless of how the for-await unwinds.
        let resolveCycle: () => void = () => undefined;
        this.#currentCycle = new Promise<void>((res) => {
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
        // Whether the most recent `response.completed` of this attempt carried
        // NO assistant content at all (no text, reasoning, tool calls, or
        // server-tool items). A clean cycle's last completed response is its
        // final answer — when that answer is empty the model effectively
        // returned nothing, which the post-loop empty-response net converts
        // into an {@link EmptyModelResponseError} so the transient retry
        // machinery can re-issue the cycle instead of reporting a silent
        // "success" the consumer can't distinguish from a no-op.
        let lastResponseEmpty = false;
        // Whether the CURRENT TURN streamed any assistant-visible work: a
        // non-empty text/reasoning delta, a function_call item, a server-tool
        // item, or a tool result. Reset on every turn_start so it mirrors
        // `lastResponseEmpty` (which tracks the last completed response —
        // i.e. the final turn). Belt-and-braces companion to that flag: the
        // completed event's `output` echo and the streamed events should
        // agree, but if a provider/SDK shape ever streams content without
        // echoing it into the final output, retrying would discard work the
        // consumer already saw — so streamed activity vetoes the empty net.
        let sawAssistantActivity = false;
        // Reset the failure capture for this attempt — a stale event from a
        // failed-and-retried predecessor cycle must not poison this attempt's
        // post-loop safety net or the outer catch's reason extraction.
        pendingFailedEvent = null;

        // Hung-stream watchdog for this cycle ATTEMPT (a transient retry of
        // the cycle creates a fresh monitor with a fresh clock). `0` disables
        // — the raw SDK stream is consumed directly, byte-identical to the
        // pre-watchdog behavior. Disposed in the cycle finally below (and
        // eagerly after a clean drain) so no timer outlives its cycle.
        const stallMonitor =
          this.opts.streamStallTimeoutMs > 0
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
              if (signal.aborted) continue;
              const turnNumber = event.turnNumber;
              if (turnNumber > maxTurnNumber) maxTurnNumber = turnNumber;
              lastTurnNumber = turnNumber;
              turnEndEmitted = false;
              sawAssistantActivity = false;
              yield { type: 'turn_start', turnNumber };
              continue;
            }
            if (isTurnEndEvent(event)) {
              if (signal.aborted) continue;
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
              sawAssistantActivity = true;
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
              if (signal.aborted) break;
              continue;
            }
            if ('type' in event && event.type === 'response.output_text.delta') {
              if (signal.aborted) continue;
              const delta = (event as { type: string; delta: string }).delta;
              if (delta) {
                sawAssistantActivity = true;
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
              if (signal.aborted) continue;
              const delta = (event as { type: string; delta: string }).delta;
              if (delta) {
                sawAssistantActivity = true;
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
              if (signal.aborted) continue;
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
              const resp = (event as { response?: unknown }).response as {
                model?: unknown;
                output?: unknown;
                usage?: { cost?: unknown } | null;
              };
              const extracted = extractAssistantContent(resp.output);
              lastResponseEmpty = isEmptyAssistantOutput(extracted, resp.output);
              if (persistSession) {
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
              if (signal.aborted) continue;
              const item = (event as { type: string; item: { type: string } }).item;
              if (item.type === 'function_call') {
                const fnItem = item as {
                  type: 'function_call';
                  callId: string;
                  name: string;
                  arguments: string;
                };
                let input: unknown;
                try {
                  input = JSON.parse(fnItem.arguments);
                } catch {
                  input = fnItem.arguments;
                }
                toolCallNames.set(fnItem.callId, fnItem.name);
                sawAssistantActivity = true;
                yield {
                  type: 'tool_call',
                  callId: fnItem.callId,
                  name: fnItem.name,
                  input,
                };
              } else if (isServerToolOutputItem(item)) {
                // OpenRouter server-executed tools (datetime / web_search /
                // web_fetch). These bypass the client tool path entirely:
                // OpenRouter runs them and returns a single output item that
                // carries BOTH the invocation and its result. Emit a
                // `server_tool` event (and persist a matching transcript
                // record) so consumers can render them alongside client tools
                // without inventing a synthetic call/result pair.
                const normalized = normalizeServerToolItem(item);
                sawAssistantActivity = true;
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
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(msg, { cause: err });
            }
          }
          // Empty-response net: the cycle "completed" but its final response
          // carried no assistant content at all — no text, no reasoning, no
          // tool calls, no server-tool items. Providers occasionally return
          // such a blank 200 instead of a proper error; left alone it would
          // surface as `stream_complete{status:'success'}` with literally
          // nothing for the consumer to show. Throwing here hands it to the
          // catch arm below, where {@link isTransientCycleFailure} classifies
          // it transient and the bounded retry re-issues the cycle. An
          // interrupt legitimately truncates output mid-turn, so the SDK's
          // persisted `status: 'interrupted'` is consulted first and wins
          // (the post-cycle interrupt path handles that case). Only fires
          // when `response.completed` was actually seen — a stream that
          // closed without one is the silent-hang anomaly handled above,
          // whose persistence semantics are ambiguous enough that a retry
          // could duplicate the user items in state. Streamed assistant
          // activity (deltas, tool calls, server-tool items) vetoes the net
          // even when the completed output echo looks empty — retrying would
          // discard work the consumer already saw.
          if (responseCompleted && lastResponseEmpty && !sawAssistantActivity && !signal.aborted) {
            const stateNow = await this.stateAccessor.load();
            if ((stateNow as { status?: string } | null)?.status !== 'interrupted') {
              throw new EmptyModelResponseError();
            }
          }
        } catch (err) {
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
          const attempt: number = retryState?.attempt ?? 0;
          const transient = !signal.aborted && isTransientCycleFailure(pendingFailedEvent, err);
          if (!transient || attempt >= maxTransientRetries) throw err;
          const reason =
            pendingFailedEvent !== null
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
          if (signal.aborted) throw err;
          continue;
        } finally {
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
        const stateStatus = (stateAfter as { status?: string } | null)?.status;
        if (stateStatus === 'interrupted') {
          const reason =
            (stateAfter as { interruptedBy?: string } | null)?.interruptedBy ?? 'interrupted';
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
    } catch (err) {
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
      const message =
        pendingFailedEvent !== null
          ? extractResponseFailedMessage(pendingFailedEvent)
          : err instanceof Error
            ? err.message
            : String(err);
      // Structured failure context: routing metadata off the failed event, or
      // statusCode/body off an HTTP-level SDK error. The serialized event is
      // logger-only (it can be large); `detail` rides on the error event so
      // hosts can log provider/attempt specifics without re-parsing `message`.
      const detail =
        pendingFailedEvent !== null
          ? extractResponseFailedDetail(pendingFailedEvent)
          : extractHttpErrorDetail(err);
      logger?.('error', 'OpenRouterAgentRun stream errored', {
        message,
        ...(detail !== undefined && { detail }),
        ...(pendingFailedEvent !== null && {
          failedEvent: truncateForLog(
            safeJsonStringify(pendingFailedEvent),
            MAX_LOG_FAILED_EVENT_CHARS,
          ),
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
    } finally {
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
        } catch (err) {
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
        if (startedAt === undefined) continue;
        await safeFireHook('PluginStop', {
          event: 'PluginStop',
          pluginName: plugin.manifest.name,
          durationMs: Date.now() - startedAt,
          reason: 'closed',
        });
      }
      // Routers: dispose every router that reached the init phase, paired 1:1
      // with the init loop above. A throwing `dispose` is swallowed (logged at
      // `error`) so one misbehaving router can't break the rest of cleanup.
      for (const router of initializedRouters) {
        if (!router.dispose) continue;
        try {
          await router.dispose();
        } catch (err) {
          logger?.('error', 'Router dispose failed', { router: router.name, error: err });
        }
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
          const messages = (persistedState as { messages?: unknown } | null)?.messages;
          const stateMessages = Array.isArray(messages) ? messages : [];
          // Cheap, model-independent pre-check: if there's nothing to summarize
          // (history shorter than keepRecentTurns — same guard compact() uses),
          // skip both the compaction-model resolution and the threshold math.
          // This keeps short runs from needlessly consulting the router's
          // compaction phase (which, for a classifier router, costs a call).
          const { summarize } = partitionMessages(stateMessages, this.opts.keepRecentTurns);
          if (summarize.length > 0) {
            // Resolve the compaction model FIRST so the threshold check sizes
            // against the routed real model's context window (not the 128k
            // default a pseudomodel would silently fall to), then thread the
            // decision into compact() so the route is consulted only once.
            const compaction = await this.resolveCompactionModel(stateMessages);
            // Record the resolution (if the model was a pseudomodel) so the
            // trailing yield at the end of `finally` surfaces it. Captured even
            // when the threshold check below skips the actual compaction call —
            // the route was still consulted (and, for a classifier router, paid
            // for), so "emit on every resolution" holds.
            pendingCompactionDecision = compaction.decision;
            if (this.isOverCompactionThreshold(stateMessages, compaction.model)) {
              await this.compact('auto', compaction);
            }
          }
        } catch (err) {
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

      // Final statement of `finally`: surface the compaction-phase
      // `router_decision` (if auto-compaction routed a pseudomodel). It must be
      // last — a `yield` here suspends the generator, and on an early-`break`
      // consumer's `return()` the suspension would skip anything after it; with
      // nothing after, no cleanup is lost. Full-drain consumers receive it as a
      // trailing event after `stream_complete`; early-`break` consumers may not.
      if (pendingCompactionDecision !== undefined) {
        yield pendingCompactionDecision;
      }
    }
  }
}

interface DeriveCompletionInput {
  totalCostUsd: number;
  maxBudgetUsd: number;
  maxTurnNumber: number;
  maxTurns: number;
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
function wrapToolWithPermission(t: Tool, canUseTool: CanUseTool): Tool {
  // Server tools run on OpenRouter — no client-side execute to gate. Pass through.
  if (!isClientTool(t)) return t;
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  // Tools without a local execute (e.g. SDK "manual" or generator forms) run
  // outside our wrapper; pass them through unchanged.
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    const canUseCtx: CanUseToolContext = {
      signal: new AbortController().signal,
      suggestions: [],
    };
    let decision: CanUseToolResult;
    try {
      decision = await canUseTool(name, input, canUseCtx);
    } catch (err) {
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
  } as Tool;
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
const TOOL_TIMEOUT_EXEMPT_NAMES: ReadonlySet<string> = new Set([
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
function isToolTimeoutExempt(name: string): boolean {
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
function wrapToolWithTimeout(t: Tool, timeoutMs: number): Tool {
  if (timeoutMs <= 0 || !isClientTool(t)) return t;
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  if (typeof originalExecute !== 'function' || isToolTimeoutExempt(name)) return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            JSON.stringify({
              error: `tool ${name} timed out after ${timeoutMs}ms`,
              timedOut: true,
            }),
          ),
        );
      }, timeoutMs);
    });
    // Async IIFE (not Promise.resolve): a SYNCHRONOUS throw from execute
    // must become a rejection of `execution` so it flows through the race
    // and the finally below. A bare sync throw would escape before the
    // try/finally and leave the deadline timer armed — rejecting with no
    // handler 60s later as an unhandledRejection.
    const execution = (async () => originalExecute(input, ctx))();
    try {
      return await Promise.race([execution, deadline]);
    } catch (err) {
      // When the deadline won, `execution` is orphaned and may reject later
      // — attach a no-op handler so it can't become an unhandledRejection.
      // When `execution` itself threw, the extra handler is harmless (the
      // rejection was already observed via the race).
      void execution.catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ...t,
    function: {
      ...t.function,
      execute: wrappedExecute,
    },
  } as Tool;
}

/**
 * Tool-execution activity sink consumed by {@link wrapToolWithActivityTracker}.
 * `begin` fires immediately before a wrapped execute starts; `end` fires in a
 * finally when it settles (resolve, reject, or timeout). The agent loop wires
 * these to an in-flight counter that suspends the hung-stream watchdog
 * ({@link OpenRouterAgentRunOptions.streamStallTimeoutMs}) while any client
 * tool runs, and bumps the stall clock on completion.
 */
interface ToolActivitySink {
  begin(): void;
  end(): void;
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
function wrapToolWithActivityTracker(t: Tool, sink: ToolActivitySink): Tool {
  if (!isClientTool(t)) return t;
  const fn = t.function as { execute?: (i: unknown, c?: unknown) => unknown };
  const originalExecute = fn.execute;
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    sink.begin();
    try {
      return await originalExecute(input, ctx);
    } finally {
      sink.end();
    }
  };
  return {
    ...t,
    function: {
      ...t.function,
      execute: wrappedExecute,
    },
  } as Tool;
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
function wrapToolWithHooks(
  t: Tool,
  safeFireHook: (event: HookEvent, payload: HookPayload) => Promise<unknown>,
  logger?: AgentLogger,
): Tool {
  // Server tools run on OpenRouter — no client-side execute to wrap. Pass through.
  if (!isClientTool(t)) return t;
  const fn = t.function as { name: string; execute?: (i: unknown, c?: unknown) => unknown };
  const name = fn.name;
  const originalExecute = fn.execute;
  if (typeof originalExecute !== 'function') return t;
  const wrappedExecute = async (input: unknown, ctx?: unknown): Promise<unknown> => {
    const sdkCallId = (ctx as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
    const callId = typeof sdkCallId === 'string' && sdkCallId.length > 0 ? sdkCallId : randomUUID();
    // Merge ctx.notify onto the SDK-supplied ToolExecuteContext so tools
    // (built-in or custom) can emit Notification hooks. Object.assign tolerates
    // a missing source ctx (returns just the notify-bearing object), so there's
    // no need to branch on ctx shape — the wrapper is only ever applied when
    // onHook is wired, so notify is always present in the merged result.
    const ctxWithNotify = Object.assign({}, ctx as object | undefined, {
      notify: (
        level: 'info' | 'warn' | 'error',
        message: string,
        context?: unknown,
      ): Promise<unknown> =>
        safeFireHook('Notification', { event: 'Notification', level, message, context }),
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
    } catch (err) {
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
  } as Tool;
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
function parsePreToolUseAction(
  raw: unknown,
  toolName: string,
  logger?: AgentLogger,
): PreToolUseAction {
  if (raw == null) return { action: 'continue' };
  if (typeof raw !== 'object') {
    logger?.('warn', 'PreToolUse handler returned a non-object; treating as continue', {
      toolName,
      returned: raw,
    });
    return { action: 'continue' };
  }
  const obj = raw as { action?: unknown; reason?: unknown; input?: unknown };
  if (obj.action === 'continue') return { action: 'continue' };
  if (obj.action === 'block') {
    if (typeof obj.reason === 'string') return { action: 'block', reason: obj.reason };
    logger?.('warn', 'PreToolUse block action missing string `reason`; treating as continue', {
      toolName,
    });
    return { action: 'continue' };
  }
  if (obj.action === 'modify') {
    if ('input' in obj) return { action: 'modify', input: obj.input };
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
function namedFromPositional(
  names: readonly string[],
  args: readonly string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    out[names[i]!] = i < args.length ? args[i]! : '';
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
const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set(['server_error', 'overloaded']);

/**
 * Thrown by the per-cycle empty-response net when a callModel cycle completed
 * normally (`response.completed` arrived, nothing threw) but its final
 * response carried no assistant content at all — no output text, no
 * reasoning, no tool calls, no server-tool items. Providers occasionally
 * return such a blank 200 instead of a proper error; without this the run
 * would end `status: 'success'` with nothing to show. Always classified
 * TRANSIENT by {@link isTransientCycleFailure}, so the bounded retry
 * machinery re-issues the cycle (with empty input — the SDK persisted the
 * user items atomically with the empty assistant output, so the retry
 * continues from stored history). With retries exhausted or disabled
 * (`maxTransientRetries: 0`) it surfaces like any terminal cycle failure:
 * `error` + `stream_complete{status:'error'}` — a visible failure beats a
 * silent empty success.
 */
export class EmptyModelResponseError extends Error {
  constructor() {
    super(
      'Model returned an empty response (no text, reasoning, tool calls, or server-tool output)',
    );
    this.name = 'EmptyModelResponseError';
  }
}

/** Read a numeric `statusCode` property off an arbitrary value, if present. */
function statusCodeAt(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Find the numeric `statusCode` that `@openrouter/sdk`'s `OpenRouterError`
 * hierarchy exposes on HTTP-level failures. Checks the error itself, then one
 * `cause` hop — the post-loop silent-hang safety net rethrows the SDK error
 * wrapped as `new Error(msg, { cause })`, which would otherwise hide the code.
 */
function extractStatusCode(err: unknown): number | undefined {
  return statusCodeAt(err) ?? statusCodeAt((err as { cause?: unknown } | null)?.cause);
}

/**
 * Classify a failed callModel cycle as transient (worth retrying) or not.
 *
 * A {@link StreamStallError} (hung-stream watchdog fired) is always
 * transient — a dead connection is exactly the class of failure a fresh
 * cycle attempt heals — and is checked first because a stall says nothing
 * about any `response.failed` event that may have been captured earlier in
 * the same attempt. An {@link EmptyModelResponseError} (cycle completed but
 * the final response carried no assistant content) is likewise always
 * transient — a blank 200 is a provider hiccup a re-issued cycle heals.
 * Otherwise: when a `response.failed` event was captured
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
function isTransientCycleFailure(failedEvent: unknown, err: unknown): boolean {
  if (err instanceof StreamStallError) return true;
  if (err instanceof EmptyModelResponseError) return true;
  if (failedEvent !== null) {
    const code = (failedEvent as { response?: { error?: { code?: unknown } | null } | null })
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
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
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
function extractResponseFailedMessage(event: unknown): string {
  const e = event as {
    message?: unknown;
    response?: {
      error?: { code?: unknown; message?: unknown } | null;
      incompleteDetails?: { reason?: unknown } | null;
    } | null;
  };
  const suffix = formatResponseFailedSuffix(extractResponseFailedDetail(event));
  const err = e.response?.error;
  if (err && typeof err.message === 'string' && err.message.length > 0) {
    const base =
      typeof err.code === 'string' && err.code.length > 0
        ? `${err.code}: ${err.message}`
        : err.message;
    return `${base}${suffix}`;
  }
  if (typeof e.message === 'string' && e.message.length > 0) return `${e.message}${suffix}`;
  const reason = e.response?.incompleteDetails?.reason;
  if (typeof reason === 'string' && reason.length > 0) return `${reason}${suffix}`;
  return `Response failed${suffix}`;
}

/** A single normalized routing attempt extracted from `openrouterMetadata.attempts`. */
type FailedAttempt = { model?: string; provider?: string; status?: number };

/**
 * Extract structured failure context from a `response.failed` event: the
 * response `id`/`model` plus OpenRouter routing metadata (`openrouterMetadata`
 * survives the SDK's parsing even though `response.error` itself is stripped
 * to `{code, message}`). Every field is optional and unknown-shaped input
 * never throws. Returns `undefined` when nothing usable is present.
 */
function extractResponseFailedDetail(event: unknown): Record<string, unknown> | undefined {
  const resp = (event as { response?: unknown }).response;
  if (resp === null || typeof resp !== 'object') return undefined;
  const r = resp as {
    id?: unknown;
    model?: unknown;
    openrouterMetadata?: {
      summary?: unknown;
      requested?: unknown;
      region?: unknown;
      attempts?: unknown;
    } | null;
  };
  const detail: Record<string, unknown> = {};
  if (typeof r.id === 'string') detail.responseId = r.id;
  if (typeof r.model === 'string') detail.model = r.model;
  const meta = r.openrouterMetadata;
  if (meta !== null && meta !== undefined && typeof meta === 'object') {
    if (typeof meta.summary === 'string') detail.routingSummary = meta.summary;
    if (typeof meta.requested === 'string') detail.requested = meta.requested;
    if (typeof meta.region === 'string') detail.region = meta.region;
    if (Array.isArray(meta.attempts)) {
      const attempts: FailedAttempt[] = [];
      for (const raw of meta.attempts) {
        if (raw === null || typeof raw !== 'object') continue;
        const a = raw as { model?: unknown; provider?: unknown; status?: unknown };
        const attempt: FailedAttempt = {};
        if (typeof a.model === 'string') attempt.model = a.model;
        if (typeof a.provider === 'string') attempt.provider = a.provider;
        if (typeof a.status === 'number') attempt.status = a.status;
        if (Object.keys(attempt).length > 0) attempts.push(attempt);
      }
      if (attempts.length > 0) detail.attempts = attempts;
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
function formatResponseFailedSuffix(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return '';
  const parts: string[] = [];
  const head = [detail.responseId, detail.model].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (head.length > 0) parts.push(head.join(' '));
  const attempts = detail.attempts;
  // The extractor only sets `attempts` when non-empty, so no length guard.
  if (Array.isArray(attempts)) {
    const rendered = (attempts as FailedAttempt[])
      .slice(0, MAX_SUFFIX_ATTEMPTS)
      .map((a) => `${a.provider ?? '?'}→${a.status ?? '?'}`);
    const extra =
      attempts.length > MAX_SUFFIX_ATTEMPTS
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
function extractHttpErrorDetail(err: unknown): Record<string, unknown> | undefined {
  const statusCode = extractStatusCode(err);
  const body = bodyAt(err) ?? bodyAt((err as { cause?: unknown } | null)?.cause);
  const detail: Record<string, unknown> = {};
  if (statusCode !== undefined) detail.statusCode = statusCode;
  if (body !== undefined) detail.body = truncateForLog(body, MAX_DETAIL_BODY_CHARS);
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** Read a non-empty string `body` property off an arbitrary value, if present. */
function bodyAt(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const body = (value as { body?: unknown }).body;
  return typeof body === 'string' && body.length > 0 ? body : undefined;
}

/** Truncate `value` to `max` characters, marking the cut. */
function truncateForLog(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

/** JSON-stringify that never throws (circular refs, BigInt, …). */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
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
function detectToolResultIsError(out: { status?: string | null; output: unknown }): boolean {
  if (out.status === 'incomplete') return true;
  if (typeof out.output !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.output);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'error' && typeof obj.error === 'string') return true;
  if (obj.isError === true) return true;
  return false;
}

function extractAssistantContent(output: unknown): {
  text?: string;
  reasoning?: string;
  toolCalls?: TranscriptToolCall[];
} {
  let text = '';
  let reasoning = '';
  const toolCalls: TranscriptToolCall[] = [];
  if (!Array.isArray(output)) return {};
  for (const item of output as Array<{ type?: string; content?: unknown[] } | null>) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content as Array<{ type?: string; text?: string }>) {
        if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.content)) {
      for (const c of item.content as Array<{ text?: string }>) {
        if (typeof c?.text === 'string') reasoning += c.text;
      }
    } else if (item.type === 'function_call') {
      const fn = item as unknown as { callId?: unknown; name?: unknown; arguments?: unknown };
      let parsedInput: unknown = fn.arguments;
      if (typeof fn.arguments === 'string') {
        try {
          parsedInput = JSON.parse(fn.arguments);
        } catch {
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
  const result: { text?: string; reasoning?: string; toolCalls?: TranscriptToolCall[] } = {};
  if (text.length > 0) result.text = text;
  if (reasoning.length > 0) result.reasoning = reasoning;
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

/**
 * True when a completed response's `output` holds no assistant content at
 * all: {@link extractAssistantContent} found no text, reasoning, or tool
 * calls, AND no OpenRouter server-tool item is present (those live outside
 * the shapes extractAssistantContent reads but still represent the model
 * having done something). `extracted` must be the result of
 * `extractAssistantContent(output)` — passed in rather than recomputed
 * because the `response.completed` handler already needs it for the
 * transcript record. A missing/non-array `output` counts as empty.
 */
function isEmptyAssistantOutput(
  extracted: { text?: string; reasoning?: string; toolCalls?: TranscriptToolCall[] },
  output: unknown,
): boolean {
  if (
    extracted.text !== undefined ||
    extracted.reasoning !== undefined ||
    extracted.toolCalls !== undefined
  ) {
    return false;
  }
  return !(Array.isArray(output) && output.some(isServerToolOutputItem));
}

/**
 * Project the OR SDK's {@link Usage} shape down to the compact
 * {@link TranscriptUsage} the transcript log persists. Returns `undefined` for
 * a missing usage object so the record skips the field entirely (vs. writing
 * a zero-everywhere placeholder).
 */
function toTranscriptUsage(u: unknown): TranscriptUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const usage = u as {
    inputTokens?: number;
    outputTokens?: number;
    outputTokensDetails?: { reasoningTokens?: number };
    inputTokensDetails?: { cachedTokens?: number };
  };
  const result: TranscriptUsage = {
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

/**
 * Project a {@link RouteResolution} onto the `router_decision`
 * {@link AgentCoreEvent} variant. Shared by the main-turn and compaction
 * resolution sites so both emit an identically-shaped event. `reason` is
 * spread in only when the router supplied one (keeps the event minimal and
 * matches the optional field on the type).
 */
function buildRouterDecisionEvent(
  pseudoModel: string,
  turn: number,
  phase: 'turn' | 'compaction',
  resolution: RouteResolution,
): Extract<AgentCoreEvent, { type: 'router_decision' }> {
  return {
    type: 'router_decision',
    pseudoModel,
    resolvedModel: resolution.resolvedModel,
    turn,
    phase,
    ...(resolution.reason !== undefined && { reason: resolution.reason }),
    routerName: resolution.routerName,
    fellBack: resolution.fellBack,
  };
}

function deriveCompletionStatus(input: DeriveCompletionInput): AgentCoreEventStatus {
  if (input.totalCostUsd >= input.maxBudgetUsd) return 'max_budget';
  // Turn numbers are 0-indexed (turn 0 = initial request). stepCountIs(n)
  // stops when the *step count* (1-indexed) reaches n, i.e. when turnNumber
  // hits n - 1. Treating "max turnNumber observed + 1 >= maxTurns" as the
  // step-count threshold matches that.
  if (input.maxTurnNumber + 1 >= input.maxTurns) return 'max_turns';
  return 'success';
}
