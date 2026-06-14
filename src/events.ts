import type { Usage } from '@openrouter/agent';

export type TokenUsage = Usage;

export type AgentCoreEventStatus = 'success' | 'max_turns' | 'max_budget' | 'error';

export type AgentCoreEvent =
  | { type: 'session_started'; sessionId: string; parentSessionId?: string }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'text_delta'; content: string }
  /**
   * Live reasoning/thinking text streamed from a reasoning model — the
   * harness's analogue of the Claude SDK's thinking deltas. Emitted for each
   * `response.reasoning_text.delta` SSE event the OR Responses stream
   * produces, in arrival order (reasoning deltas precede the turn's
   * `text_delta`s on the wire). PLAINTEXT reasoning only: encrypted
   * reasoning items (`encrypted_content` with no readable text, e.g. OpenAI
   * store:false reasoning or Gemini thought signatures) never produce a
   * delta on the wire, so there is nothing to surface for them — consumers
   * must not assume every reasoning model yields these events. Empty deltas
   * are dropped at the source (parity with `text_delta`).
   */
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: unknown; isError: boolean }
  | {
      /**
       * An OpenRouter server-executed tool invocation+result (e.g.
       * `openrouter:datetime`, `openrouter:web_search`, `openrouter:web_fetch`).
       * Unlike client `tool_call`/`tool_result`, these run on OpenRouter's
       * servers and arrive as a single response output item carrying both the
       * invocation and its result — there is no client call/result round-trip
       * and no `canUseTool` gate. Emitted once per server-tool output item.
       */
      type: 'server_tool';
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
    }
  | {
      /**
       * A pseudomodel (autorouter) resolution. Emitted whenever the run's
       * configured `model` is a pseudomodel — i.e. some {@link
       * import('./router.js').RouterPlugin} claims it — and the resolution
       * engine produced a concrete model for a request. Carries the full
       * provenance so a consumer can render/log which router fired, what it
       * chose, and why.
       *
       * Fire timing differs by `phase`:
       * - `'turn'` — yielded inline in the main loop immediately BEFORE the
       *   cycle's `callModel`, so it precedes that turn's `turn_start`. A
       *   sticky route emits this only on the first cycle that resolves it (the
       *   cached decision short-circuits routing on later cycles); a
       *   `sticky: false` route re-emits every cycle.
       * - `'compaction'` — yielded at the very END of the run (after
       *   `stream_complete` and the lifecycle hooks), because auto-compaction
       *   runs post-loop in the generator's `finally`. Consumers that drain the
       *   stream to completion observe it as a trailing event; consumers that
       *   `break` early on `stream_complete` may not see it. It is ignored by
       *   the rich-message projection ({@link import('./messages.js')}), so the
       *   `ResultMessage` terminator is unaffected.
       *
       * `fellBack` is `true` when routing failed (the router threw, or resolved
       * to another pseudomodel past the depth guard) and `resolvedModel` is the
       * fail-safe default rather than the router's choice.
       */
      type: 'router_decision';
      /** The fake ID the run requested (e.g. `auto/coding`). */
      pseudoModel: string;
      /** The concrete model the request actually runs against. */
      resolvedModel: string;
      /** Cycle index for `'turn'`; `0` for the single `'compaction'` pass. */
      turn: number;
      phase: 'turn' | 'compaction';
      /** Rationale from the router, when it supplied one. */
      reason?: string;
      /** {@link import('./router.js').RouterPlugin.name} of the claiming router. */
      routerName: string;
      /** `true` when this is the fail-safe default, not the router's choice. */
      fellBack: boolean;
    }
  | { type: 'turn_end'; turnNumber: number; usage: TokenUsage | null; costUsd: number }
  | {
      type: 'stream_complete';
      status: AgentCoreEventStatus;
      usage?: TokenUsage | null;
      costUsd?: number;
      durationMs?: number;
      reason?: string;
    }
  | {
      type: 'error';
      message: string;
      cause?: unknown;
      /**
       * Structured failure context when one could be extracted: for an
       * in-stream `response.failed` event — `responseId`, `model`, and
       * OpenRouter routing metadata (`requested`, `region`, `routingSummary`,
       * per-attempt `attempts: {model, provider, status}[]`); for an
       * HTTP-level SDK error — `statusCode` and a truncated raw `body`.
       */
      detail?: Record<string, unknown>;
    };

/**
 * Lifecycle hook event names fired by an {@link OpenRouterAgentRun}. Hooks are
 * audit-only — their return value cannot mutate the run, and exceptions thrown
 * inside a hook are logged and swallowed so they cannot break the agent.
 *
 * Fire order on the happy path:
 * `Setup` → `SessionStart` → (`PreToolUse`/`PostToolUse` pairs)* → `SessionEnd` → `Stop`.
 *
 * `Setup` and `Stop` always bracket the run — even when construction throws or
 * the run aborts before any model traffic. `Notification` is the only event
 * that is NOT fired by the runtime automatically: callers (library code or
 * custom tools via {@link ToolContext.notify}) emit it to push status updates
 * to subscribers.
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'Setup'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentEnd'
  | 'PreCompact'
  | 'McpServerStart'
  | 'McpServerStop'
  | 'PluginStart'
  | 'PluginStop';

/**
 * Summary of a finished subagent run. Mirrors the fields of a `stream_complete`
 * {@link AgentCoreEvent} (the same shape surfaced as a `ResultMessage` on the
 * aggregated message stream). Carried on the {@link HookPayload} variant for
 * `SubagentEnd` so subscribers can correlate cost/usage/duration with the
 * subagent that produced them. `text` is the concatenation of every
 * `text_delta` the subagent yielded — the same byte stream the parent's
 * model sees inside the `spawn_subagent` tool_result.
 */
export interface SubagentResultSummary {
  status: AgentCoreEventStatus;
  usage?: TokenUsage | null;
  costUsd?: number;
  durationMs?: number;
  reason?: string;
  text: string;
}

/**
 * Discriminated union of hook payloads. The `event` field is the discriminator
 * — narrowing on it selects the correct payload shape.
 *
 * `usage` on `SessionEnd` is nullable: a run that aborts or fails before any
 * model response arrives has no usage to report. Consumers that want a numeric
 * fallback should treat null as zero.
 */
export type HookPayload =
  | { event: 'SessionStart'; sessionId: string; cwd: string; model: string }
  | {
      event: 'SessionEnd';
      sessionId: string;
      status: AgentCoreEventStatus;
      usage: TokenUsage | null;
      costUsd: number;
    }
  | { event: 'PreToolUse'; toolName: string; input: unknown; callId: string }
  | {
      event: 'PostToolUse';
      toolName: string;
      input: unknown;
      output: unknown;
      isError: boolean;
      callId: string;
    }
  /**
   * Fires once per {@link OpenRouterAgentRun} instance, BEFORE `SessionStart`.
   * Use for first-run resource provisioning (cache warmup, scratch dirs, etc.).
   * Lifetime semantics are per-run-instance, not per-process.
   */
  | { event: 'Setup'; sessionId: string; cwd: string }
  /**
   * Fires once per run, AFTER `SessionEnd`. Always the last hook event in the
   * run — even on abort or constructor-throw. `status` mirrors the final
   * {@link AgentCoreEventStatus}; `reason` carries an error message when one
   * is known (abort or thrown error).
   */
  | { event: 'Stop'; status: AgentCoreEventStatus; reason?: string }
  /**
   * Caller-emitted status update. The runtime never fires `Notification`
   * automatically; library code or custom tools push these via
   * {@link ToolContext.notify} (or by calling `onHook` directly) to surface
   * progress/errors to subscribers.
   */
  | {
      event: 'Notification';
      level: 'info' | 'warn' | 'error';
      message: string;
      context?: unknown;
    }
  /**
   * Fires on the parent run's `onHook` immediately BEFORE a subagent is
   * driven by the built-in `spawn_subagent` tool (Phase 4.7). Inherited
   * hooks (`SessionStart`, `PreToolUse`, …) still fire from inside the
   * subagent — `SubagentStart`/`SubagentEnd` bracket those without
   * replacing them. `depth` is the subagent's own chain index (root = 0,
   * first subagent = 1, …). `toolNames` echoes the optional whitelist
   * supplied to the spawn (undefined → subagent inherited the full parent
   * pool). The matching `SubagentEnd` always fires — even on a
   * depth-cap rejection (carries `status: 'error'`, `reason: 'max
   * subagent depth …'`) or a runner throw.
   */
  | {
      event: 'SubagentStart';
      parentSessionId: string;
      subagentSessionId: string;
      depth: number;
      prompt: string;
      toolNames?: readonly string[];
    }
  /**
   * Fires on the parent run's `onHook` after a subagent run completes,
   * aborts, or rejects at the depth cap (Phase 4.7). The `result` envelope
   * mirrors the subagent's terminal `stream_complete` event — same fields
   * the {@link import('./messages.js').ResultMessage} carries — plus the
   * concatenated assistant text the parent's model receives as the
   * `tool_result`. `result.status` reflects the run's exit status (or
   * `'error'` on a depth-cap rejection / runner throw, with `reason`
   * populated). Always paired 1:1 with the preceding `SubagentStart` (same
   * `subagentSessionId` / `depth`).
   */
  | {
      event: 'SubagentEnd';
      parentSessionId: string;
      subagentSessionId: string;
      depth: number;
      result: SubagentResultSummary;
    }
  /**
   * Phase 5.1: fires immediately BEFORE a context-compaction call runs, with
   * the message prefix that is about to be condensed and the `keepRecentTurns`
   * window the runtime decided to preserve verbatim. `reason` is `'auto'` when
   * the per-turn threshold check triggered the compaction, `'manual'` when
   * {@link OpenRouterAgentRun.compact} was called explicitly.
   *
   * Audit-only — the hook's return value is ignored and a thrown error is
   * logged + swallowed (compaction proceeds regardless). Consumers typically
   * use this to archive the pre-compaction transcript before it is rewritten
   * on disk. `messages` is the prefix slice straight from
   * `ConversationState.messages` (matching the SDK's `InputsUnion` shape) —
   * do NOT mutate it in place.
   */
  | {
      event: 'PreCompact';
      messages: unknown;
      keepRecentTurns: number;
      reason: 'auto' | 'manual';
    }
  /**
   * Phase 5.2.5: fires once per MCP server immediately AFTER its JSON-RPC
   * `initialize` handshake succeeds and the bridge has finished listing the
   * server's tools/resources/prompts. Init failures DO NOT fire this event —
   * they fire the existing `Notification` hook with
   * `message: 'mcp_server_failed'` instead, so `McpServerStart` is a strong
   * signal that the server is live and its capabilities are known.
   *
   * `capabilities.tools` / `capabilities.resources` / `capabilities.prompts`
   * are the counts returned by the corresponding `list*` calls at init time —
   * NOT the raw arrays, to keep the payload cheap to log and serialize. A
   * server that does not advertise a given capability (e.g. tools-only) is
   * reported as `0` for the omitted lists.
   *
   * Audit-only — the hook's return value is ignored and a thrown error is
   * logged + swallowed (the run continues).
   */
  | {
      event: 'McpServerStart';
      serverName: string;
      transport: 'stdio' | 'streamableHttp' | 'sse';
      capabilities: { tools: number; resources: number; prompts: number };
    }
  /**
   * Phase 5.2.5: fires once per MCP server when the bridge tears it down at
   * the end of an agent run. Only servers whose handshake previously
   * succeeded (i.e. whose {@link McpServerStart} fired) emit this event —
   * init failures do not fire either side of the bracket.
   *
   * `durationMs` is `Date.now() - startedAt` captured at successful init —
   * millisecond precision is sufficient for observability without pulling
   * in `performance.now()`. `reason` distinguishes:
   *
   * - `'closed'` — normal teardown at the end of a successful run.
   * - `'error'` — the underlying `client.close()` threw.
   * - `'aborted'` — the bridge's run-level `signal` is `aborted` at close
   *   time (the run was cancelled mid-stream, taking the bridge down with it).
   *
   * Audit-only — same swallow-on-throw convention as the rest of the hooks.
   */
  | {
      event: 'McpServerStop';
      serverName: string;
      durationMs: number;
      reason: 'closed' | 'error' | 'aborted';
    }
  /**
   * Phase 5.8: fires once per loaded plugin after its {@link LoadedPlugin}
   * contributions are folded into the agent's skill / command / MCP / hook
   * registries. Mirrors the {@link McpServerStart} pattern: payloads carry
   * COUNTS (not the raw arrays) so logging is cheap and PII-safe.
   *
   * `contributions.skills` / `commands` / `mcpServers` / `hooks` are the number
   * of entries the loader resolved for the plugin. A plugin that ships only a
   * single skill reports `{ skills: 1, commands: 0, mcpServers: 0, hooks: 0 }`.
   * Auto-discovered plugins (no manifest) still emit a payload — counts come
   * from the default-path scan, not the manifest.
   *
   * Audit-only — the hook's return value is ignored and thrown errors are
   * logged + swallowed (the run continues).
   */
  | {
      event: 'PluginStart';
      pluginName: string;
      root: string;
      contributions: {
        skills: number;
        commands: number;
        mcpServers: number;
        hooks: number;
      };
    }
  /**
   * Phase 5.8: fires once per loaded plugin when the agent run finalizes
   * (`finally` block in `iterate()`). Always paired 1:1 with the preceding
   * {@link PluginStart} for the same `pluginName`. `durationMs` measures from
   * the matching `PluginStart` fire-time.
   *
   * `reason: 'closed'` is the happy path. `'error'` is reserved for future
   * cleanup-failure paths (v1 has no per-plugin teardown action that can
   * throw, so it never fires today — declared for forward compatibility
   * with the v2 `${CLAUDE_PLUGIN_DATA}` lifecycle work).
   *
   * Audit-only — same swallow-on-throw convention as the rest of the hooks.
   */
  | {
      event: 'PluginStop';
      pluginName: string;
      durationMs: number;
      reason: 'closed' | 'error';
    };

/**
 * Optional return value from a `PreToolUse` hook handler. Returning `void` (or
 * `undefined`) is equivalent to `{ action: 'continue' }` — the tool call
 * proceeds with the original input. The other two variants short-circuit or
 * mutate the call before `canUseTool` runs:
 *
 * - `block` — the tool is NOT executed. A synthetic denial result is surfaced
 *   as `tool_result.isError = true` with the same payload shape `canUseTool`'s
 *   deny path produces (`JSON.stringify({ error: reason, denied: true })`),
 *   and `PostToolUse` still fires with the synth output so audit consumers see
 *   a matched Pre/Post pair.
 * - `modify` — the substituted `input` becomes the effective input for the
 *   remainder of the call: `canUseTool` (if any) sees the modified input, and
 *   so does the tool's `execute`. The `tool_call` event already yielded to the
 *   consumer still reflects the ORIGINAL input — `modify` is invisible at the
 *   event-stream layer except via the eventual `tool_result`.
 *
 * Only the `PreToolUse` event reads this return value. Every other hook event
 * stays void-returning; the return type for the union widens just enough to
 * remain backward-compatible without forcing handlers to switch on `event`.
 */
export type PreToolUseAction =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; input: unknown };
