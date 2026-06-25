# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Context compaction v2 — Card 7.1: real-token trigger + dynamic context
  windows.** Auto-compaction no longer waits for run end and no longer relies
  solely on a `chars/4` estimate over the message array:
  - **Mid-run trigger.** After each `callModel` cycle, the run compares the
    server-reported real `usage.inputTokens` against a token-denominated
    threshold. When it crosses, compaction is marked and performed at the top
    of the next cycle (Codex-style "mark-full → compact at the next turn"),
    inside the same `iterate()` — so a long multi-input agentic run that
    drains many turns is protected before it can overflow. The existing
    public `compact()` mid-iterate guard semantics are unchanged. The run-end
    check reuses the same signal (fires only when the final cycle crossed the
    threshold), so a run never double-compacts the same history.
  - **Token-denominated threshold.** `contextWindow − outputReserve −
safetyBuffer` (absolute-buffer shape, à la Claude Code / opencode),
    floored at 25% of the window, where `outputReserve` (default ~20k tokens)
    guarantees the summarizer call itself has room to respond. New options
    `outputReserveTokens` / `safetyBufferTokens`; the merged
    `resolveCompactionThresholdTokens` resolver gains an optional
    `reserveOpts` parameter (prior ratio behavior preserved when omitted).
  - **Dynamic context windows.** The active model's window is resolved with
    the precedence: explicit `contextWindowTokens` (new option) → live OR
    `/api/v1/models` `context_length` lookup → static `MODEL_CONTEXT_WINDOWS`
    table (with per-run `modelContextWindows` overrides) → 128k fallback. The
    live lookup (`ModelContextLengthCache`, exported) is lazy, per-base-URL
    TTL-cached, and **failure-tolerant** — a network error falls back to the
    static table, so compaction never gains a hard network dependency.
  - **Cold-start estimate.** On the first turn of a fresh session (no real
    usage sample yet), the fallback estimate now counts the `instructions`
    block and serialized tool schemas
    (`estimateInstructionsAndToolsTokens`, exported), not just the message
    history — the two large prefix components a cron-style session sends on
    every request.
  - **`persistSession` gating.** Both the mid-run and run-end compaction
    triggers are skipped for `persistSession: false` runs (no resume path →
    pure waste), fixing the cron-one-shot footgun of paying for a summary the
    session never uses.
  - Back-compat: an explicit `compactionThreshold` still wins outright
    (chars, or tokens with a `tokenCounter`) and bypasses the real-token path
    (and the `/models` lookup) entirely.

- **`reasoning_delta` core event — live reasoning/thinking streaming.**
  Reasoning models that stream plaintext reasoning over the OR Responses
  wire (`response.reasoning_text.delta` SSE events) now surface it live:
  the agent loop yields a new `{ type: 'reasoning_delta', content }`
  `AgentCoreEvent` for each delta (Claude-SDK thinking-delta parity).
  Encrypted reasoning items carry no delta on the wire and produce no
  events; empty deltas are dropped and post-abort deltas filtered, matching
  `text_delta`. The rich message stream (`run.messages()`) aggregates
  contiguous reasoning deltas into a new `ThinkingContent`
  (`{ type: 'thinking', thinking }`) block on the open `AssistantMessage`,
  in strict event order — since reasoning streams before visible output,
  thinking blocks precede the text/tool blocks they led to. Subagent
  result text (`SubagentResultSummary.text` / the parent's
  `spawn_subagent` tool_result) intentionally remains visible-text-only.
  Covered by `src/agent.streaming.test.ts` + `src/messages.test.ts`.

- **`streamStallTimeoutMs` — hung-stream watchdog (default 2 min).**
  A silently dropped SSE connection used to hang a run forever: the OR
  Responses wire is unidirectional with no heartbeat, so a dead upstream
  produces no error, no close, no events. The new per-cycle watchdog
  (`src/stall.ts`: `createStallMonitor` + `monitorStream`) races each
  stream pull against a re-arming timer; when NO events arrive for
  `streamStallTimeoutMs` while NO client tool execute is in flight, the
  cycle fails with the new exported `StreamStallError` (carries
  `stallTimeoutMs`). Tool executions legitimately silence the stream, so
  an unconditional outermost tool wrapper tracks in-flight executes
  (every path: built-ins, custom tools, MCP-bridge tools) and suspends
  the clock — a 5-minute `bash` run never trips it. On stall the dead
  SDK stream is cancelled and the error is classified TRANSIENT, so the
  bounded retry/backoff (`maxTransientRetries`) re-issues the cycle with
  a fresh monitor; exhausted retries surface `error` +
  `stream_complete{status:'error'}` with the stall reason. The orphaned
  iterator pull is catch-drained (no `unhandledRejection`), timers are
  unref'd and disposed in a finally, and the watchdog is never armed
  during the post-stream response fetch. Constructor option; `0`
  disables; inherited by spawned subagents. Covered by
  `src/stall.test.ts` + `src/agent.stall.test.ts` (fake timers).

- **`toolTimeoutMs` — per-tool execute deadline (default 1 min).**
  A client tool whose `execute` never settles used to wedge the run (the
  SDK awaits tool results before continuing the turn). The harness now
  races every non-exempt client tool execute against a deadline; on
  timeout it throws `JSON.stringify({ error: 'tool <name> timed out
after <N>ms', timedOut: true })` — mirroring the `canUseTool` deny
  convention — so the SDK emits a normal error-enveloped
  `function_call_output`, `detectToolResultIsError` flags it, and the
  run continues with the model seeing the failure. The wrapper composes
  INNERMOST (inside permission/hook wrappers) so `PostToolUse` and the
  `tool_result` both reflect the timeout. Exempt: `bash` and `monitor`
  (own model-controllable `timeout_ms` / `max_duration_ms`),
  `spawn_subagent`/`spawn_subagents` (long-running by design),
  `ask_user_question` (blocks on a human answering),
  `skill` (fork-context skills run a subagent inside execute), and
  MCP-bridged tools (`<server>__<tool>`
  names — external servers own their semantics). The losing execute's
  underlying I/O is NOT cancelled in v1 (no signal plumbing) — the loop
  just stops waiting, and the orphaned promise's settlement is
  swallowed. Constructor option; `0` disables; inherited by spawned
  subagents. Covered by `src/agent.tool-timeout.test.ts` (fake timers).

- **Compaction accounting options: `modelContextWindows` + `tokenCounter`.**
  Two knobs make the Phase 5.1 auto-compaction estimate accurate for
  models/tokenizers the harness doesn't know:
  - `modelContextWindows?: Record<string, number>` — per-run overrides
    merged over the static `MODEL_CONTEXT_WINDOWS` table.
    `getModelContextWindow(model, overrides?)` now resolves: override
    exact → override `~`-stripped alias → static exact → static alias →
    `DEFAULT_CONTEXT_WINDOW_TOKENS`. Threaded through both threshold
    resolvers and the agent's auto-compact call site.
  - `tokenCounter?: (serializedMessages: string) => number` — real
    tokenizer hook. When set, the auto-compaction check serializes the
    persisted history via the new shared
    `serializeMessagesForEstimate(messages)` (the exact string the
    chars/4 heuristic measures — `estimateMessagesCharLength` is now its
    `.length`), passes it to the counter, and compares against a TOKEN
    threshold from the new `resolveCompactionThresholdTokens(configured,
model, overrides?)` (`configured ?? floor(window * 0.8)`).
    **`compactionThreshold` is reinterpreted as TOKENS when
    `tokenCounter` is set; without it the historical CHARS reading is
    unchanged (back-compat).** A throwing counter logs a `warn` and
    falls back to the char heuristic for that check.

  Both options are inherited by spawned subagents. Covered by
  `src/compaction.test.ts` + `src/__tests__/integration/compaction.test.ts`.

- **Surface OpenRouter server tools (`openrouter:datetime` / `web_search` /
  `web_fetch`) as first-class events and transcript records.** Server tools are
  injected into the request and executed on OpenRouter's servers, returning a
  single response output item that carries both the invocation and its result —
  they never pass through the client `canUseTool` / tool-execution path. The run
  loop previously dropped these items entirely: they produced no
  `AgentCoreEvent` and were not persisted to `transcript.jsonl` (they survived
  only in `state.json`, which most consumers don't read). Downstream UIs
  therefore had no way to show that the model performed a web search / fetch /
  datetime lookup.

  This release adds:
  - A new `AgentCoreEvent` variant `{ type: 'server_tool', toolType, callId?,
status, input?, output, isError }`, emitted once per `openrouter:*` response
    output item. `input` carries the recoverable model input where one exists
    (`web_search` → `{ query }`); `output` is the item payload with the
    envelope keys (`type`/`id`/`status`) stripped; `isError` is derived from a
    `web_fetch` `error` field or any non-`completed` status.
  - A matching `server_tool` transcript record kind (additive — readers already
    skip unknown `kind`s, so `TRANSCRIPT_SCHEMA_VERSION` is unchanged), written
    in lockstep with the event when `persistSession` is on, plus a
    `logTranscriptServerTool` writer.
  - Rich-stream parity: `aggregateMessages` projects each `server_tool` event
    onto a `tool_use` + `tool_result` pair (correlated by `callId`, falling back
    to `toolType` when the provider omits an id) so `run.messages()` renders
    server tools uniformly with client tools.
  - Pure, SDK-free helpers `isServerToolOutputItem` / `normalizeServerToolItem`
    (new module `tools/server-tool-items.ts`, re-exported from
    `tools/server-tools.ts` and `tools/index.ts`) so the projection logic is
    unit-testable and reusable by consumers.

- **Bounded retry with backoff for transient `response.failed` errors.**
  A single transient upstream failure (`response.failed` with code
  `server_error` / `overloaded`, or an HTTP 5xx from the SDK) used to be
  terminal: it killed the entire multi-cycle agent run. Observed in
  production on 2026-06-10 — callboard cron sessions `ce7247e2` (8
  successful generations, then one upstream 500 → whole run dead) and
  `b11b0fd7`, both on valid payloads that replayed successfully 4/4 after
  the incident window.

  The per-cycle loop in `src/agent.ts` now retries a transiently-failed
  `callModel` cycle up to `maxTransientRetries` times (default 2) with
  exponential backoff (`transientRetryBaseDelayMs * 2^attempt`, default
  base 500ms). Both knobs are constructor options, inherited by spawned
  subagents; `maxTransientRetries: 0` restores the previous behavior. Each
  retry logs at `warn` level with the failure reason and attempt number.

  Scope and safety:
  - Only transient classes retry: `response.failed` code `server_error` /
    `overloaded` (the structured event code is authoritative), or an HTTP
    5xx `statusCode` on the thrown error / its `cause`. Aborts, 4xx-class
    errors, moderation blocks, and budget exhaustion never retry.
  - Re-issuing the same fresh input is duplication-safe by SDK design:
    `saveResponseToState` persists pending fresh user items atomically with
    the assistant output only after a response completes (vendor
    model-result.js — "avoiding duplication when a caller retries after a
    transient API failure"), so a cycle that died before its first
    completed response left state untouched. When a FOLLOW-UP turn died
    instead, the fresh items are already in state — the retry re-issues
    the cycle with an empty input and continues from history. Either way
    fresh user items never appear twice in state (verified by test).
  - Retried cycles don't double-count toward `max_turns` (run-wide
    turn-number max, not a sum) and reuse the failed cycle's request id so
    `logs/<session>/req_*/` stays 1:1 with logical cycles. The failed
    attempt's pending SDK rejection is drained before the backoff sleep,
    preserving the PR #210/#212 no-unhandled-rejection guarantees.

  Covered by `src/agent.transient-retry.test.ts` (driven through real
  stream events, including state-persistence and abort-during-backoff
  scenarios).

### Fixed

- **Host process crash on mid-stream `response.failed` (chained-promise orphan).**
  When an OpenRouter chat run hit a `response.failed` event mid-SSE (e.g.
  upstream `server_error: Internal Server Error`), the harness's catch arm
  surfaced the failure as `stream_complete{status:"error"}` correctly — but
  the host process crashed immediately afterward from an unhandled promise
  rejection. Observed deterministically in callboard's host daemon on
  `openai/gpt-5.4 @ xhigh`.

  Root cause: `ModelResult.startTurnBroadcasterExecution`
  (model-result.js:230) creates TWO promise objects from one underlying
  execution — the cached `toolExecutionPromise` (what `getResponse()`
  awaits) and a separate `.finally(...)`-chained `executionPromise`
  returned to the SDK generator and observed only by `getFullResponsesStream`'s
  terminal `await executionPromise;` (model-result.js:1586).

  The harness's `response.failed` handler used to throw immediately. That
  closed the SDK generator via `iter.return()` BEFORE it reached
  `await executionPromise;`. Meanwhile, the SDK's own `consumeStreamForCompletion`
  consumer of the same broadcaster saw the failure and rejected
  `toolExecutionPromise`; the `.finally(...)` chain propagated that
  rejection onto `executionPromise` — which now had no observer. Node
  fired `unhandledRejection` and the host exited.

  The existing drain `void resultHandle.getResponse().catch(() => undefined)`
  only mopped up `toolExecutionPromise` (idempotently cached on `this`);
  the chained promise is a separate object.

  Fix in `src/agent.ts`: instead of throwing eagerly on `response.failed`,
  capture the event into a `pendingFailedEvent` local and `continue` the
  for-await loop. The SDK's own consumer then throws and rejects
  `toolExecutionPromise`; the chained `.finally(...)` runs
  `broadcaster.complete()`; the harness's for-await drains naturally; the
  SDK generator advances to `await executionPromise;` and observes the
  chained rejection — both promises observed, no orphan. A safety-net
  throw after the for-await loop and a catch-arm override using
  `extractResponseFailedMessage(pendingFailedEvent)` preserve the
  pretty-printed reason (e.g. `server_error: Internal Server Error`)
  even when the SDK's own throw carries the JSON-stringified envelope.

  Locks in by regression test `src/agent.chained-promise-rejection.test.ts`,
  which asserts no `unhandledRejection` fires after a `response.failed` on
  both initial-turn and follow-up-turn cycles.

- **Encrypted reasoning content now requested on every model call.** The main
  `callModel` in `src/agent.ts` now sends
  `include: ["reasoning.encrypted_content"]` unconditionally. The harness
  always runs with `store: false` semantics, and OpenAI's Responses API
  contract only guarantees `encrypted_content` on reasoning items when this
  `include` is present — reasoning items without it (synthetic `rs_tmp_*` ids,
  plaintext summaries only) cannot be faithfully echoed back to reasoning
  models on follow-up turns and rely on provider-side leniency. With the fix,
  OpenAI-routed runs persist reasoning items with real `rs_*` ids and
  `encryptedContent` into `state.json`, and the SDK echoes them back as
  `encrypted_content` on subsequent turns. Verified harmless for
  Anthropic-routed (signature-carrying reasoning items, unaffected) and
  Gemini-routed (provider-native encrypted thought-signature items) models.

  Known limitation (server-side, not fixable in this repo): when OpenRouter
  server tools (`openrouter:datetime` / `openrouter:web_search` /
  `openrouter:web_fetch`) are present in the request — the harness default
  unless `disableServerTools: true` — OpenRouter's server-side tool
  orchestration strips native reasoning payloads and synthesizes `rs_tmp_*`
  ids regardless of `include`. Runs with `disableServerTools: true` get the
  full benefit today; server-tool runs start benefiting automatically once
  OpenRouter honors `include` in that path.

## [0.2.1] - 2025-07-15

### Fixed

- **Silent-hang when OR API returns a 4xx with server tools enabled.**
  When `disableServerTools: false` (the default since callboard commit
  `0880737`) and the OpenRouter API rejects the request with a non-2xx
  HTTP status (e.g. a 402 "insufficient credits"), the agent run would
  hang forever — yielding `session_started` and then nothing. No `error`
  event, no `stream_complete`, and no logger output.

  Root cause: the SDK's `_do` method calls `hooks.afterError(ctx, response,
null)` on non-2xx responses. When no `afterError` hook was registered (only
  `beforeCreateRequest` was), the default `SDKHooks.afterError` returned
  `{response, error: null}`, which did not throw and allowed the SDK to
  continue with the 4xx response object. In certain `ModelResult` internal
  code paths (specifically when the turn broadcaster completes without an
  error and `getFullResponsesStream()` exits cleanly with no events) the
  failure never surfaced as a throw into agent.ts's `for await` loop.

  Two complementary fixes:
  1. **`src/tools/server-tools.ts` — `afterError` hook**: `createServerToolsHooks()`
     now also registers an `afterError` hook. When `error` is absent
     (the SDK swallowed the HTTP error), the hook reads the response body,
     extracts `error.message` / `message` from JSON (or uses the raw body
     text / `statusText` as fallback), and returns
     `{ response, error: new Error('OpenRouter request failed (${status}): ${detail}') }`.
     This causes the SDK to throw the error, propagating it through
     `ModelResult.initStream()` into `getFullResponsesStream()`.

  2. **`src/agent.ts` — defense-in-depth in `iterate()`**: after the
     `for await (const event of result.getFullResponsesStream())` loop
     exits, if no `response.completed` event was ever observed AND the
     signal is not aborted, the agent now calls `await result.getResponse()`
     in a try/catch. Any rejection is re-thrown, which the outer catch
     block converts to an `error` event + `stream_complete{status:"error",
reason}`. This catches any future SDK path that closes the SSE stream
     without surfacing an error.

### Changed

- Reclassified Skills system / Slash commands / Plugins from
  out-of-scope (originally Bucket D — host responsibility) to in-scope.
  Library now aims to be a Claude Code + Agent SDK replacement, not just
  the SDK layer. Implementation: Cards 5.6 (slash commands), 5.7
  (skills), 5.8 (plugins), gated on spike 5.S4 (architecture
  investigation). See Card 3.0 / PR #95.
- `compileGlobToRegex` in `src/utils/glob.ts` now treats `**/` as
  zero-or-more path segments (previously one-or-more), aligning with the
  standard gitignore / minimatch / bash-globstar semantic. Because the
  helper is shared, this silently broadens matching for two pre-existing
  callers:
  - `tool-filters` rule grammar (Phase 3.2) — e.g.
    `disallowedTools: ['Edit(src/**/foo.ts)']` now also matches
    `src/foo.ts` (in addition to `src/a/foo.ts`, `src/a/b/foo.ts`, …).
  - `grep_files` `file_glob` option (Phase 3.10) — same broadening:
    `file_glob: 'src/**/*.ts'` now also picks up files directly under
    `src/`. Patterns without `**/` are unaffected; `*`, `?`, and
    character-class behavior is unchanged.

### Added

- `OpenRouterAgentRunOptions.disableServerTools?: boolean` — opt-out of OR's
  built-in server-side tool injection (`openrouter:datetime` /
  `openrouter:web_search` / `openrouter:web_fetch`). Default `false`: hooks
  remain registered, preserving prior behavior. When `true`, the OR client
  constructed by `createOpenRouterClient` omits the `hooks` entry that
  appends the three server tools to every request body. Inherited by spawned
  subagents (per-`SubagentRunConfig` override wins). Motivation: interim
  workaround for an upstream OR cache bug where the server tools defeat
  `cache_control` auto-prompt-caching on Anthropic models when combined with
  user-defined tools — costing roughly 10x on multi-turn Opus/Sonnet
  sessions. Consumers that don't need OR's server-side datetime/web access
  can set this `true` to recover caching.

- `OpenRouterAgentRunOptions.cacheControl?: AnthropicCacheControlDirective`
  — thin passthrough for OpenRouter's auto-prompt-cache directive. When set,
  the value is forwarded as the top-level `cacheControl` field on the
  `callModel` request body so OR can automatically apply cache breakpoints
  to the last cacheable block. Inherited by spawned subagents (parent
  default flows in; per-`SubagentRunConfig` override wins) and by the
  isolated compaction `callModel` (large reusable prefixes benefit from the
  same cache). Omitted runs send no `cacheControl` on the wire (preserves
  default behavior). Currently honored only by Anthropic Claude models.
  Comparative scenario #23 exercises the OR-side passthrough; the Claude
  Agent SDK has no equivalent request-level cache knob (prompt caching on
  Anthropic lives per-content-block on `TextBlockParam`), so the scenario
  is OR-only on the Anthropic side — documented asymmetry in the scenario
  body. To make the field reach the wire end-to-end, this PR also adds a
  direct `@openrouter/sdk` dependency and an `overrides` entry pinning the
  transitive resolution to `^0.12.79` — the first 0.12.x point release whose
  generated `ResponsesRequest` model declares `cacheControl` (0.12.35,
  which `@openrouter/agent@0.3.2` pulls in by default, only declared it on
  `ChatRequest`, silently stripping the field on the OpenResponses path the
  agent uses). PR #205.

- Phase 5.8: Plugins — Claude Code-compatible plugin manifest + directory
  loader. **This is the consummating Phase 5 card: the library now reaches
  full parity with Claude Code + the Agent SDK on the in-scope dimensions
  (slash commands, skills, plugins, MCP, hooks, subagents, streaming input,
  compaction, tool-search, effort, session forking, checkpoints).** Card #109.

  New public API:
  - `loadPlugins({ pluginDirs, home?, logger? }) → Promise<LoadedPlugin[]>` —
    resolves a caller-supplied list of plugin directories to aggregated
    contributions ready to fold into the agent. Auto-discovery (directory
    name → plugin name) kicks in when `.claude-plugin/plugin.json` is absent.
    Per-plugin parse failures log + skip; surviving plugins still load.
  - `pluginManifestSchema` (Zod) — validates `.claude-plugin/plugin.json`
    against the documented shape: `name` required; `displayName`, `version`,
    `description`, `author`, `homepage`, `repository`, `license`, `keywords`,
    `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `outputStyles`,
    `lspServers`, `userConfig`, `dependencies`, `experimental` — all
    optional. Unknown top-level keys pass through (forward-compat with
    manifests written against newer Claude Code builds).
  - `OpenRouterAgentRunOptions.plugins?: readonly LoadedPlugin[]` ctor
    option. Each entry contributes: skill discovery roots (namespaced
    `<pluginName>:<skillName>`), MCP server entries (namespaced
    `<pluginName>:<serverName>`), and hook configs.
  - `PLUGIN_NAME_REGEX`, `PLUGIN_DEFAULT_PATHS`, `PLUGIN_MCP_NAMESPACE_SEPARATOR`
    — exported alongside the schema for hosts building their own walkers.
  - Re-exported types: `PluginManifest`, `LoadedPlugin`, `PluginHookConfig`,
    `LoadPluginsOptions`.

  Two new lifecycle hooks bracket every loaded plugin:
  - `PluginStart` — fires once per plugin after the MCP bridge handshakes.
    Payload: `{ pluginName, root, contributions: { skills, commands,
mcpServers, hooks } }`. Counts (not arrays) for cheap audit logging,
    matching the `McpServerStart` pattern.
  - `PluginStop` — fires once per plugin from the run's `finally` block
    (always 1:1 paired with `PluginStart`). Payload: `{ pluginName,
durationMs, reason: 'closed' | 'error' }`. v1 only emits `'closed'`;
    `'error'` is declared for the future `${CLAUDE_PLUGIN_DATA}` cleanup
    lifecycle.

  Composition rules (per the Claude Code docs):
  - **`skills` ADDS to the default `<root>/skills/`** — extra paths in the
    manifest layer on. Skill loader's `SkillLoaderOptions.pluginRoots`
    gained an additive `skillsDir?: string` field so plugins with multiple
    skill paths each emit one pluginRoot entry.
  - **`commands` / `agents` REPLACE the default** `<root>/commands/` /
    `<root>/agents/`.
  - **`hooks`, `mcpServers`** — accept either inline objects or relative
    file paths; the loader normalizes both shapes.

  Substitution: `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are
  resolved inside plugin-shipped skill bodies (when the active skill came
  from a plugin, the agent's skill-tool `buildContext` populates both fields
  from the owning `LoadedPlugin`). `${CLAUDE_PLUGIN_DATA}` is a path string
  only — the directory is NOT auto-created in v1 (v2 deferred, see below).

  Namespace collision rules:
  - Plugin skills: namespaced via Phase 5.7's `<pluginName>:<skillName>`.
  - Plugin commands: namespaced via Phase 5.6's `<pluginName>:<command>`.
  - Plugin MCP servers: namespaced `<pluginName>:<serverName>` (matches the
    skill/command separator; the bridge's internal `<serverName>__<toolName>`
    formatting still applies on top, producing
    `<pluginName>:<serverName>__<toolName>`).
  - Plugin hooks: composed alongside the user `onHook` via `safeFireHook`
    broadcast — no collision possible (every subscriber fires).

  **v1 deferrals** (accepted in the manifest schema, NOT implemented at
  runtime):
  - `userConfig` runtime (prompt-on-enable + keychain integration).
  - `dependencies` (no install lifecycle / transitive resolver).
  - `experimental.themes`, `experimental.monitors` (out of scope).
  - `lspServers` (LSP integration is broader v2; not on the parity roadmap).
  - Plugin hook command execution — `LoadedPlugin.hookConfigs` exposes the
    parsed config for host inspection; v1 does NOT spawn hook command
    children. Hosts can read and dispatch themselves.
  - Marketplace fetcher (`marketplace.json` → install/update/uninstall flow
    - `~/.claude/plugins/cache/` resolution).
  - `${CLAUDE_PLUGIN_DATA}` directory auto-creation + cleanup lifecycle —
    the path string resolves but no directory is created or pruned.
  - `bin/` directory PATH injection (Phase 3.9's enhanced Bash tool already
    handles per-tool path overrides; revisit if a real plugin needs it).
  - `channels` — deferred pending channel-protocol design (Phase 5.3
    streaming input is shipped, but the channel ↔ MCP server binding is a
    separate piece of plumbing).

  Re-exports from the top-level index: `loadPlugins`,
  `pluginManifestSchema`, `PLUGIN_NAME_REGEX`, `PLUGIN_DEFAULT_PATHS`,
  `PLUGIN_MCP_NAMESPACE_SEPARATOR`, types `PluginManifest`, `LoadedPlugin`,
  `PluginHookConfig`, `LoadPluginsOptions`.

- Phase 5.6: Slash commands — Claude Code-compatible `.claude/commands/*.md`
  discovery + host-side `/`-input resolver, built as a flat-file degenerate
  skill that reuses the Phase 5.7 frontmatter parser + substitution helper
  end-to-end (no new YAML dep). Public API: `createCommandLoader({ cwd, home,
pluginRoots, skillLoader?, disableSkillShellExecution })` → `{ list(),
resolve(input, ctx?) }`. Discovery walks project (cwd up to `.git` boundary,
  depth-10 cap) + user (`<home>/.claude/commands/`) + plugin scopes; subdir
  paths namespaced with `:` (`git/commit.md` → `git:commit`); plugin commands
  always namespaced `<pluginName>:<command>`. Commands are HOST-invoked
  (model never sees them): the host calls `resolve('foo bar "baz qux"')`,
  receives `{ name, args, body }`, and feeds `body` as the next prompt to
  `OpenRouterAgentRun({ prompt })`. Frontmatter is OPTIONAL — a body-only
  `.md` file is a valid command; its name is inferred from the filename.
  **Converged-menu** (opencode pattern): when a `skillLoader` is supplied,
  `list()` also surfaces every skill as a `source: 'skill'` command
  (command wins on same-name collision) — lets hosts present one unified
  `/`-menu over built-ins + commands + skills + plugins. Unknown command →
  `undefined` (host shows "no such command", does not throw). Re-exports:
  `createCommandLoader`, `parseCommandFile`, `COMMAND_NAMESPACE_SEPARATOR`,
  types `CommandInfo` / `CommandFrontmatter` / `CommandSource` /
  `CommandLoader` / `CommandLoaderOptions` / `CommandResolveContext` /
  `ResolvedCommand`. Card #107.
- Phase 5.7: Skills system — Claude Code-compatible `.claude/skills/<name>/SKILL.md`
  discovery, listing injection, and a built-in `skill` tool (Card #108).
  New constructor options on `OpenRouterAgentRun`:
  - `skills?: SkillLoader` — pre-built loader (use `createSkillLoader({ cwd, home, pluginRoots })`).
  - `skillsDir?: string` — convenience: builds a default loader bound to the supplied path.
  - `skillDescriptionBudget?: number` — fraction of the model context window
    reserved for the `## Available Skills` listing (default `0.01`, ~2k chars).
  - `disableSkillShellExecution?: boolean` — replaces every `` !`cmd` `` /
    fenced ` ```! ``` ` block with `[shell command execution disabled by policy]`.
  - `skillEnv?: Readonly<Record<string,string>>` — narrow env map for generic
    `${VAR}` passthrough inside skill bodies (defaults to `{}`).

  The `skill({ name, arguments? })` tool renders a skill body in a single pass:
  variable substitution (`${CLAUDE_SESSION_ID}` / `${CLAUDE_PROJECT_DIR}` /
  `${CLAUDE_SKILL_DIR}` / `${CLAUDE_EFFORT}` / `${user_config.<key>}` /
  generic `${ENV}`), positional / named arguments (`$ARGUMENTS`,
  `$ARGUMENTS[N]`, `$N`, `$<name>` from `frontmatter.arguments`), and
  shell execution (`` !`cmd` `` inline + fenced ` ```! ``` ` blocks; position-
  restricted to start-of-line or after whitespace; output NOT re-scanned).
  Shell blocks honor the run's `AbortSignal` with a 60s default per-block
  timeout (SIGTERM → 250ms grace → SIGKILL).

  Frontmatter (`SkillFrontmatter`) mirrors the cross-vendor
  [`agentskills.io`](https://agentskills.io/specification) spec plus Claude
  Code's extension fields (`when_to_use`, `arguments`, `allowed-tools`,
  `argument-hint`, `disable-model-invocation`, `user-invocable`, `model`,
  `effort`, `context: fork`, `agent`, `paths`, `shell`). Parsed via a
  hand-rolled YAML subset (no new runtime deps) and validated through Zod.

  Discovery walks three scopes (highest precedence first): plugin roots
  (namespaced `<plugin>:<skill>`) → user (`<home>/.claude/skills/<name>/SKILL.md`)
  → project (walk up from `cwd` to `.git` or 10 levels, deepest match wins).
  Caller-decides-cwd invariant preserved: `process.cwd()` still resolves
  exactly once at the agent boundary; the walker never reads
  `process.env.HOME`.

  `context: fork` skills delegate to the Phase 4.7 `spawn_subagent` runner —
  the rendered body becomes the subagent's prompt, and the subagent's text
  flows back as the tool result. Requires `enableSubagents: true`; without
  it the skill inlines and surfaces a `runSubagent not wired` note. Unknown
  `frontmatter.agent` types fall back with a warn log instead of throwing.

  Per-skill `allowed-tools: Bash(git:*) Read` layers an additional narrowing
  gate on top of the run-level `canUseTool` / `permissionMode` /
  `allowedTools` for the duration of the render (install/dispose hook via
  `ActiveSkillContext`). Denials from the outer gate still win.
  - Inline-render narrowing semantics: on the inline path, the skill's
    `allowed-tools` is the complete set of tools the model may invoke
    while the skill renders. Any tool not matched by at least one of the
    listed rules is denied with reason
    `tool '<name>' not in skill '<skill>' allowed-tools`. The run-level
    gate (`canUseTool` / `allowedTools` / `disallowedTools` /
    `permissionMode`) still runs after the narrow check and can deny
    further — run-level deny-wins is preserved.

  Each successful render fires the `Notification` hook
  (`level: 'info'`, `message: 'skill_loaded'`, `context: { name, source }`)
  so audit consumers can observe activations without polling.

  New public exports from the package root: `createSkillLoader`, `loadSkills`,
  `parseSkillFile`, `parseYamlFrontmatter`, `normalizeFrontmatterKeys`,
  `splitShellArgs`, `renderSkillBody`, `substituteVariables`,
  `substituteArguments`, `skillFrontmatterSchema`, `SKILL_NAME_REGEX`,
  `MAX_SKILL_PROJECT_WALK_DEPTH`, `DEFAULT_SKILL_SHELL_TIMEOUT_MS`,
  `SKILL_SHELL_DISABLED_MARKER`, `skillTool`, `splitAllowedTools`,
  `buildSkillListing`, `DEFAULT_SKILL_DESCRIPTION_BUDGET`, plus type-only
  exports for `SkillFrontmatter`, `SkillInfo`, `SkillSource`, `SkillLoader`,
  `SkillLoaderOptions`, `SubstitutionContext`, `SkillToolOptions`,
  `SkillToolResult`, `ActiveSkillContext`.

  Coverage thresholds in `vitest.config.ts` modestly relaxed
  (99.6/98.65/98.8/99.93 → 98.9/96.0/98.5/99.5) to reflect the skills
  system's many short-circuit branches across the frontmatter surface and
  multi-shape argument parsing. Per-file coverage for the new modules is
  ≥90% on every metric.

- Phase 5.5: `tool_search` + `tool_load` dynamic MCP tool discovery
  (Card #NN). New opt-in
  `OpenRouterAgentRunOptions.enableToolSearch?: boolean` (default
  `false`) hides the per-run MCP bridge's tools from the model's initial
  tool pool and exposes two built-in tools instead:
  - `tool_search({ query, limit? })` ranks `bridge.catalog` (name +
    description, char-cap-200 `schema_preview` with `…` truncation
    marker; substring weight 10/5, per-token weight 2/1; tie-break
    ascending by name) and returns up to `DEFAULT_SEARCH_LIMIT` (10,
    capped at `MAX_SEARCH_LIMIT` = 50) `{ name, server, description,
schema_preview, score }` envelopes. Empty catalog / empty query
    return `{ matches: [], note }` instead of throwing.
  - `tool_load({ names })` registers one or more by-prefixed-name into
    a per-run mutable `toolsForRun` array; results bucket into
    `loaded` / `alreadyLoaded` / `notFound`. Each successful load
    fires `Notification(level: 'info', message: 'tool_loaded',
context: { name, server })` so audit consumers can observe the
    working-set growth.
  - New `McpBridge.catalog` getter exposes the raw MCP tool list
    (`{ name, server, description?, inputSchema? }`) without forcing
    the search index to reach through the Zod-meta wrapper
    `mapMcpToolToTool` stores on each wrapped Tool.
  - Loaded-tool state is per-run and does NOT propagate to spawned
    subagents — subagents see whatever tool pool their own
    constructor opts produce.
  - When `enableToolSearch: false` (the default), prior Phase 5.2.4
    behaviour is preserved: every bridge tool is unconditionally
    visible to the model up front. Ignored when the caller supplies a
    custom `tools` array.
  - Permission gating (`permissionMode` / `allowedTools` /
    `disallowedTools` / `canUseTool` from Phase 3.\*) still fires per
    call on the dynamically-loaded tools.
- Phase 5.3: Streaming input mode (Card #104).
  Adds the Claude-SDK-shaped multi-turn ergonomic on top of OR's
  between-turn `interruptedBy` state primitive — implementation is an
  interrupt-then-restart loop hidden behind a thin facade
  (see [spike 5.S2](./plans/spikes/5.S2-streaming-input.md) for the
  trade-off analysis).
  - `OpenRouterAgentRunOptions.prompt` widens from `string` to
    `string | AsyncIterable<UserInput>`. Plain `string` keeps the
    single-shot back-compat path; `AsyncIterable<UserInput>` drives a
    multi-turn loop where each yielded `UserInput` is the next user
    message.
  - `OpenRouterAgentRun.pushUserMessage(msg: UserInput | string)`
    queues a follow-up message imperatively. Resolves immediately —
    unbounded FIFO buffer, drained before the iterable on each
    between-turn pull.
  - `OpenRouterAgentRun.interrupt()` writes
    `state.interruptedBy = 'host-interrupt'` via the run's
    `StateAccessor`; the SDK's `checkForInterruption` polling observes
    the flag between turns and exits the in-flight `callModel`
    cleanly. Idempotent: safe to call before iteration starts (the
    first cycle exits immediately) and after the run terminates
    (no-op). Returns when the in-flight cycle has unwound.
  - Multi-turn restart loop carries `messages` + `partialResponse`
    across cycles via the existing `StateAccessor`. Between cycles,
    the interrupted partial assistant text is committed as a proper
    `assistant` message in `ConversationState.messages` and the
    `partialResponse` field is cleared — preserving the conversation
    transcript across the interrupt.
  - Image / file attachments ride on `UserInput.content`, which
    accepts `string | ReadonlyArray<unknown>` (OR-shaped content
    blocks: `input_text`, `input_image`, `input_file`, `input_audio`,
    `input_video`). The library performs no client-side validation —
    OR's Responses API does the Zod-level check server-side.
  - New `UserInput` type exported from the public API surface
    (named distinctly from `messages.ts`'s `UserMessage` aggregator).
    `streaming-input.ts` houses the source class, normalization
    helpers, partial-response commit, and the interrupt-flag writer.
  - `messages()` rich stream stays consistent: an interrupted cycle's
    open `AssistantMessage` is flushed via a synthetic `turn_end`
    event so the message stream's per-turn boundaries don't drift
    relative to the event stream.
  - Interrupt granularity is between turns / between SSE event
    batches — NOT mid-token, because OR's wire is unidirectional SSE.
    Matches the Claude SDK's coarser cross-provider behaviour; the
    spike documents this as the intentional trade-off.
  - Auto-compaction (Phase 5.1) fires once at end-of-run, NOT between
    streaming-input turns, so the two phases don't race on
    `state.json`.
- Phase 5.2.5: MCP server integration (Model Context Protocol).
  Consummates the 5.2.\* series — adds two new lifecycle hook events
  (`McpServerStart` / `McpServerStop`) and the full integration test
  suite that exercises the bridge against a real subprocess MCP server
  fixture. `McpServerStart` fires once per server immediately after a
  successful JSON-RPC `initialize` handshake, carrying
  `{ serverName, transport, capabilities: { tools, resources, prompts } }`
  (capability counts only, not the raw arrays — kept cheap to log).
  `McpServerStop` fires once per server at bridge teardown with
  `{ serverName, durationMs, reason: 'closed' | 'error' | 'aborted' }`.
  Failed-init servers fire neither event — they continue to surface
  through `Notification`/`mcp_server_failed` as before. Both events are
  audit-only (return value ignored, thrown handlers logged + swallowed).
  README now ships a public-API-stable MCP section consolidating
  constructor options (`mcpServers` / `autoDiscoverMcp`), `.mcp.json`
  shape, tool-name prefixing (`MCP_TOOL_NAME_SEPARATOR`), transport
  differences (stdio vs streamable HTTP vs deprecated SSE), and the
  three hook events. Parity-matrix row "MCP server support" graduates
  None → Full; "Custom tools" graduates Partial → Full.
- Phase 5.2.4: MCP tool bridge (preview). New `McpBridge` class in
  `src/mcp/bridge.ts` — per-run pool that spawns every configured MCP
  server (stdio via 5.2.1 / streamable HTTP via 5.2.2), completes each
  one's JSON-RPC `initialize` handshake, lists its tools, and exposes
  them on `OpenRouterAgentRun`'s tool array under the prefixed name
  `<serverName>__<toolName>`. Two new constructor options drive the
  bridge: `mcpServers?: readonly McpServerConfig[]` (explicit list,
  overrides discovery) and `autoDiscoverMcp?: boolean` (defaults to
  `false` — opt-in, since silently auto-spawning user subprocesses from
  a library ctor is surprising; set to `true` to run `loadMcpConfig`
  at iter start). Init failures DO NOT crash the run: the bridge logs
  at `warn` level, fires a `Notification` hook with
  `message: 'mcp_server_failed'` carrying `{ name, transport, source,
error }`, and continues with the remaining servers. Schema mapping
  is JSON-Schema passthrough — the MCP `inputSchema` is stored on a
  Zod `z.unknown().meta(...)` so the OR SDK's `toJSONSchema` emits the
  original JSON Schema to the model unchanged (Zod conversion is
  future work; the MCP server validates its own inputs). Lifecycle is
  per-run: bridge spawns lazily inside `iterate()` after the `Setup`
  hook fires, and `close()` runs in the `finally` block on every exit
  path (success / abort / mid-stream throw). The rule grammar used by
  `allowedTools` / `disallowedTools` was extended to accept any plain
  name containing `__` so MCP-prefixed names match verbatim (scoped
  patterns like `Bash(npm *)` are not supported for MCP tools — use a
  plain name or a `canUseTool` callback). New public exports:
  `McpBridge`, `MCP_TOOL_NAME_SEPARATOR`, `defaultClientFactory`,
  `mapMcpToolToTool`, and the supporting types (`McpBridgeOptions`,
  `McpBridgeClient`, `McpClientFactory`, `McpCallToolDispatch`).
- Phase 5.2.3: MCP `.mcp.json` config discovery (preview). New
  `loadMcpConfig()` in `src/mcp/config.ts` — pure async loader that
  walks for `.mcp.json` in two scopes (`'user'` =
  `<os.homedir()>/.mcp.json`, `'project'` = walk up from `cwd` to the
  first `.git` ancestor capped at 10 directories) and returns a
  deterministically-sorted flat `McpServerConfig[]`. Each entry is a
  discriminated union (`transport: 'stdio' | 'http'`) inferred from
  `command` vs `url` presence (or honoured explicitly when set), and
  stamped with the absolute `source` path of the originating file for
  debuggability. Default scope order is `['user', 'project']` — project
  entries override user entries by NAME (full replacement, not deep
  merge). `cwd` is optional; when omitted the project scope is silently
  skipped (user scope still works) — preserves the single
  `process.cwd()` invariant. Schema (Zod v4) rejects entries with both
  `command` and `url`, neither, malformed URL, or an explicit
  `transport` field that contradicts the field shape; errors include
  the offending file path. **Not wired into `OpenRouterAgentRun` yet**
  — that flips in Card 5.2.5 (lifecycle hooks) after the bridge in
  5.2.4 lands.
- Phase 5.2.2: MCP HTTP + SSE transport (preview). New
  `McpHttpClient` in `src/mcp/transport-http.ts` wraps
  `@modelcontextprotocol/sdk`'s `Client` driven by either
  `StreamableHTTPClientTransport` (modern, preferred — supports
  stateful sessions via `Mcp-Session-Id` and `Last-Event-ID` stream
  replay) or `SSEClientTransport` (deprecated, kept for back-compat
  with servers that haven't migrated yet). The constructor takes a
  discriminated-union options object selecting
  `transport: 'streamableHttp' | 'sse'`. Public surface mirrors
  `McpStdioClient` exactly so Card 5.2.4's tool-bridge can consume
  either client structurally — `connect` / `close` / `listTools` /
  `callTool` / `listResources` / `readResource` / `listPrompts` /
  `getPrompt`, each accepting a trailing `signal?: AbortSignal`.
  Lifecycle + per-call `AbortSignal` composition matches stdio
  (per-call signal rejects ONE request without closing the
  transport; lifecycle signal tears the client down). SDK
  lazy-loaded via dynamic `import()` inside `connect()` — zero
  cold-start cost for users without configured MCP servers. **Not
  wired into `OpenRouterAgentRun` yet** — that flips in Card 5.2.5
  (lifecycle hooks) after the bridge in 5.2.4 lands.
- Phase 5.2.1: MCP stdio transport (preview). New
  `McpStdioClient` in `src/mcp/transport-stdio.ts` wraps
  `@modelcontextprotocol/sdk@^1.29.0`'s `Client` +
  `StdioClientTransport` to spawn an MCP server subprocess, complete
  the `initialize` handshake, and expose typed `listTools` /
  `callTool` / `listResources` / `readResource` / `listPrompts` /
  `getPrompt` passthroughs. Supports `AbortSignal` (pre-aborted
  rejects `connect()`; mid-handshake aborts close the transport and
  reject pending requests) and idempotent `close()`. Shared MCP
  types re-exported from `src/mcp/spec.ts` so downstream cards
  (5.2.2 HTTP+SSE, 5.2.4 tool-bridge) consume a single internal
  seam rather than deep SDK subpath imports. SDK is loaded via
  dynamic `import()` inside `connect()` — zero cold-start cost for
  users without configured MCP servers. Vendor decision recorded
  in `plans/spikes/5.2.S1-mcp-vendor.md`. **Not wired into
  `OpenRouterAgentRun` yet** — that flips in Card 5.2.5 (lifecycle
  hooks) after the bridge in 5.2.4 lands.
- Phase 5.1: context compaction. Three new
  `OpenRouterAgentRunOptions` knobs — `compactionThreshold?: number`
  (character count, defaults to ~80% of the model's context window
  translated via a ~4 chars/token heuristic), `keepRecentTurns?: number`
  (default 5 trailing messages preserved verbatim), and
  `autoCompact?: boolean` (default `true`). When the persisted message
  history crosses the threshold between turns, the runtime spawns a
  single isolated `callModel` (session id
  `<sessionId>:compact:<uuid>`, no tools) that summarizes the prefix
  into a `developer`-role message and rewrites
  `ConversationState.messages = [summary, ...lastN]` on disk —
  `previousResponseId` is cleared so the server can't splice the stale
  response chain onto the rewritten input (see spike 5.S1 §2d). New
  public `OpenRouterAgentRun.compact()` method drives the same flow
  on demand. New `PreCompact` lifecycle hook fires audit-only with the
  prefix being condensed (`{ messages, keepRecentTurns, reason: 'auto'
| 'manual' }`). New `getModelContextWindow(model)` helper exposes
  the hard-coded window table for known Anthropic / OpenAI / Google /
  xAI / Qwen models. Closes #97.
- Phase 5.4: `OpenRouterAgentRunOptions.effort` is live (was an
  accepted-but-not-consumed stub since 4.8). Type tightened from `string`
  to the new exported `EffortLevel` alias
  (`'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'`); the
  per-subagent `effort` override on `spawn_subagent` and
  `spawn_subagents` is the same enum (Zod now rejects unknown values at
  parse time). When set, the value is forwarded into the OR `callModel`
  request body as `reasoning: { effort }`; when omitted, no `reasoning`
  field is sent — preserving each model's default behavior. The
  per-subagent inheritance plumbed in 4.8 still applies: parent's
  `effort` falls through to the child when the spawn spec omits it,
  child spec replaces it when set. OR normalizes the level and maps it
  to each provider's native param (OpenAI `reasoning_effort`, Anthropic
  `thinking.budget_tokens`, Gemini `thinkingLevel`, Qwen
  `thinking_budget`, xAI `reasoning_effort`), falling back to the
  nearest supported level for models that lack the requested one; ignored
  by non-reasoning models. See PR for issue #96 / spike 5.S3.
- Phase 4.9: parallel subagent execution via the new built-in
  `spawn_subagents` (plural) tool. Bundled alongside the singular
  `spawn_subagent` whenever `OpenRouterAgentRun({ enableSubagents: true })`
  is set — no separate opt-in flag (the two tools share a `runSubagent`
  closure and lifecycle emitter, so wiring them independently would
  force two near-identical switches on the host). The new ctor option
  `maxParallelSubagents` (default `4`) caps the number of subagents
  in-flight at once for a single plural invocation; the array itself is
  Zod-capped at `MAX_PARALLEL_BATCH_SIZE` (= 16) entries. Each spec in
  the array accepts the same per-spec fields as `spawn_subagent`
  (`description` plus optional `tools` / `instructions` / `max_turns` /
  `max_budget_usd` / `model` / `permission_mode` / `allowed_tools` /
  `disallowed_tools` / `effort`), so all Phase 4.8 overrides propagate
  per-child. Concurrency is enforced by an inline promise pool (no
  `p-limit` dep). No fail-fast — per-child failures isolate into
  `{ status: 'success' | 'error' | 'aborted', subagentSessionId,
output, error? }` envelopes; aggregate `costUsd` + token totals sum
  the `'success'` envelopes only. Parent abort fans out into every
  in-flight child via `AbortSignal.any([parentSignal,
internalCtl.signal])`. Recursion-depth gate reuses the singular tool's
  check; depth-N parent at the cap rejects each spec with the same
  `'max subagent depth (N) exceeded'` envelope. `SubagentStart` /
  `SubagentEnd` hooks fire once per child (no new event types — pairs
  may interleave when children run in parallel, correlate on
  `subagentSessionId`). Each child inherits the parent's `maxBudgetUsd`
  independently by default; per-spec `max_budget_usd` overrides
  per-child (aggregate cost may therefore exceed any single child's
  cap, but no single child can exceed its own).
- Phase 4.8: per-subagent tool / model / effort overrides on
  `spawn_subagent`. The Zod input schema gains five optional fields —
  `model?: string`, `permission_mode?: 'default' | 'acceptEdits' |
'bypassPermissions' | 'plan'`, `allowed_tools?: string[]` and
  `disallowed_tools?: string[]` (both reuse the Phase 3.2 rule grammar:
  plain names like `'read_file'` / `'Read'` or scoped rules like
  `'Bash(npm *)'` / `'Edit(src/**/*.ts)'`), and `effort?: string` — that
  the runner maps to the child `OpenRouterAgentRun`'s constructor args
  (snake_case in the tool schema → camelCase on the ctor). Each override
  REPLACES the parent's resolved value rather than composing — so
  `permission_mode: 'plan'` from a `bypassPermissions` parent isolates
  the read-only restriction to the child; the parent's own subsequent
  tool calls remain unrestricted. The 4.7 `tools?: string[]`
  pool-narrowing whitelist still composes on top of the 3.2 filters:
  `tools` controls which tool factories are available to the child;
  `allowed_tools` / `disallowed_tools` then gate calls within that pool.
  `effort` is **accepted-but-no-op** — the value is stored on both the
  spawn config and the child run's `OpenRouterAgentRunOptions.effort`
  field, but the OR `callModel` call does not yet forward it. Full
  wiring lands in Phase 5.4 (gated on spike 5.S3 — whether OR's API
  accepts an effort parameter at all). The new `effort?: string` field
  on `OpenRouterAgentRunOptions` is documented as a stub with the same
  no-op caveat so the surface stays stable. Documented in the README
  Subagents subsection and parity matrix (`Subagent tool restrictions`
  graduates Partial → Full). ([#59](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/59))

- Phase 4.7: subagent system — basic, sequential. New `spawnSubagentTool(opts, ctx?)` factory (exported from the library root) plus `OpenRouterAgentRun({ enableSubagents: true, maxSubagentDepth?: 3, currentSubagentDepth?: 0 })` constructor options that wire the built-in `spawn_subagent` tool into the default bundle. The tool's Zod input schema accepts `description: string`, optional `tools?: string[]` (whitelist of tool names that narrows the inherited parent pool — unknown names silently dropped), optional `instructions?: string`, `max_turns?: number`, and `max_budget_usd?: number` (each defaults to the parent's value when omitted). When invoked, the parent's `spawn_subagent.execute` derives a child session id (`<parentSessionId>:sub:<uuid>`), composes the parent's abort signal with a subagent-internal `AbortController` via `AbortSignal.any`, and builds a child `OpenRouterAgentRun` inheriting the parent's `apiKey` / `baseUrl` / `appTitle` / `logsRoot` / `logger` / `onHook` / `model` / `cwd` / `persistSession`. The runner drains the child's `AgentCoreEvent` stream and returns the captured `SubagentResultSummary` (status, usage, costUsd, durationMs, reason, plus concatenated assistant text) as a single `tool_result` — subagent events do NOT bleed into the parent's `for await`. Recursion cap: the spawn check `parent.currentSubagentDepth + 1` against `maxSubagentDepth` rejects when the next depth would meet or exceed the cap (default 3 → chain of at most three levels: parent → sub → sub-sub → reject 4th), surfacing `{ error: 'max subagent depth (3) exceeded', subagentSessionId }`. The `HookEvent` union is extended with `'SubagentStart'` and `'SubagentEnd'`; both payloads carry `parentSessionId`, `subagentSessionId`, `depth`, and (on End) the full `SubagentResultSummary`. Both fire even on the depth-cap rejection path so audit consumers see a matched Start/End pair. Opt-in via `OpenRouterAgentRun({ enableSubagents: true })` or by passing `AllToolsOptions.spawnSubagent` to `allTools()`; the tool is **NOT** in the default bundle when `enableSubagents` is unset (mirrors the host-hook opt-in pattern from Phase 4.1/4.2). ([#58](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/58))

- Phase 4.6: file checkpointing. New `createCheckpoint(sessionId,
logsRoot, files[], { logger? })`, `listCheckpoints(sessionId, logsRoot)`,
  and `restoreCheckpoint(checkpointId, sessionId, logsRoot)` helpers
  (exported from the library root) plus an auto-checkpoint hook on the
  built-in `write_file` and `edit_file` tools. Snapshots land at
  `<logsRoot>/<sessionId>/checkpoints/<checkpointId>/` and consist of
  `manifest.json` plus one `<encoded-path>.snapshot` companion per file —
  path encoding replaces every `/` (including the leading `/` of absolute
  paths) with the sentinel token `__SLASH__`, so each snapshot fits in a
  single basename and round-trips losslessly through the exported
  `encodePath` / `decodePath` helpers. Files absent at checkpoint time
  are recorded as tombstones (`existed: false`, no `.snapshot` file);
  restoring a tombstone unlinks the live path if it currently exists.
  `restoreCheckpoint` is atomic across the whole manifest — every file
  is first staged into `<checkpointDir>/.restore-tmp/`, then `fs.rename`d
  into place once every staged file is ready; tombstones are unlinked
  last (after all renames succeed). Per-session cap
  `MAX_CHECKPOINTS_PER_SESSION = 100` evicts the oldest checkpoint(s)
  (by `timestamp`, ascending) on overflow and logs each eviction at
  `'warn'`. Create-time fast-path: when the target file's `mtimeMs` +
  `size` match its most-recent prior snapshot in the same session, the
  new snapshot is created via `fs.link` (hard-link) instead of copying
  bytes — falls through to `copyFile` on `EXDEV` / unsupported FS.
  ([#57](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/57))
- Phase 4.6: `checkpoint?: boolean` constructor option on
  `OpenRouterAgentRun` (default `false`). When `true`, the built-in
  `write_file` and `edit_file` tools snapshot their target path under
  `<logsRoot>/<sessionId>/checkpoints/` before mutating it. Per-call
  override field `checkpoint` on those tools' input schemas wins over
  the constructor default. When the run is constructed with
  `persistSession: false`, requested checkpoints become a NO-OP — the
  library logs `'warn'` with the message `'checkpoint requested but
persistSession is false'` and the underlying write proceeds normally.
  Ignored when the caller supplies a custom `tools` array (the option
  threads through the built-in tool bundle only). Both tools also gained
  a per-call `checkpoint?: boolean` field on their Zod input schemas.
  ([#57](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/57))
- Phase 4.6: new public exports from the library root: `createCheckpoint`,
  `listCheckpoints`, `restoreCheckpoint`, `encodePath`, `decodePath`,
  `MAX_CHECKPOINTS_PER_SESSION`, plus types `Checkpoint`,
  `CheckpointFile`, `RestoreCheckpointResult`, `CheckpointLogger`.
  `ToolContext` gained five optional fields (`sessionId`, `logsRoot`,
  `checkpoint`, `persistSession`, `logger`) threaded in by `agent.ts` so
  the checkpointing tools can find the session directory and emit warn
  logs; tools that don't need them ignore the new fields.
  ([#57](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/57))
- Phase 4.5: session forking. New `forkSession({ sessionId, newSessionId?,
logsRoot })` standalone helper plus an `OpenRouterAgentRun.fork({
newSessionId? })` instance wrapper that reuses the run's resolved
  `logsRoot`. Forking copies the source session's `state.json` via atomic
  write (`*.tmp` → `rename`) into a new session directory under the same
  `logsRoot` and stamps a fresh `session.json` whose new `parentSessionId`
  field points back at the source. Per-request `req_*` / `gen_*`
  subdirectories are **not** copied — the fork inherits the OR
  `previousResponseId` chain via `state.json` alone. `newSessionId` is
  auto-minted as a UUID v4 when omitted. Forking a `persistSession: false`
  run (or any source missing `state.json`) rejects with `cannot fork
in-memory session: <id> has no on-disk state at <path>`; the instance
  wrapper's check is local — no filesystem round-trip. Standalone
  `forkSession` requires an explicit `logsRoot` (no `<cwd>/logs` default)
  to preserve the library's "exactly one `process.cwd()` call site" rule.
- Phase 4.5: `parentSessionId?: string` constructor option on
  `OpenRouterAgentRun`. When set, the value is written to the run's
  `session.json` (new optional `parentSessionId` field on `SessionLog`) and
  surfaced on the `session_started` event payload. Root sessions omit the
  field from both — back-compat with legacy `session.json` files is
  preserved by absence.
- New `monitor` client tool — spawn a shell command via `/bin/sh -c` and
  stream its stdout/stderr line-by-line into a capture buffer that resolves
  on one of four stop conditions: natural process exit, line-count cap hit,
  duration cap hit, or `ctx.signal` abort. Inputs: `command` (string,
  required), optional `cwd` (resolved against the run's `cwd`), optional
  `pattern` (JS regex string — compiled once at execute-time; invalid
  patterns resolve with `{ error: 'invalid pattern: <message>' }` rather
  than throwing), optional `max_lines` (default `1000`, silently clamped
  to `10_000` with a `warn` notification), optional `max_duration_ms`
  (default `60_000`, silently clamped to `600_000` with a `warn`
  notification). Pattern filtering happens per-line; non-matching lines
  are dropped on the floor (no buffer entry). All three forced-stop paths
  (line cap, duration cap, abort) SIGTERM the child with a 250ms SIGKILL
  grace mirroring `run_command`, and mark the returned result
  `truncated: true` with `exitCode: null`. Natural exit returns
  `truncated: false` with the real exit code. Result shape:
  `{ exitCode: number | null, lines: { stream: 'stdout' | 'stderr', text: string }[], truncated: boolean, durationMs: number }`.
  Wired into `allTools()` as the twelfth client tool; the agent's default
  tool set now ships with 12 client tools. (Phase 4.4)
- New `edit_notebook` client tool — Jupyter notebook (`.ipynb`) cell
  manipulation. Inputs: `path` (relative to the agent `cwd`), `operation`
  (Zod enum: `'replace_source'` / `'insert'` / `'delete'` /
  `'change_type'`), `cell_index` (non-negative integer; for `insert`,
  `0` prepends and `cells.length` appends), optional `new_source`
  (required for `replace_source` + `insert`), optional `new_cell_type`
  (Zod enum: `'code'` / `'markdown'`; required for `insert` +
  `change_type`). Round-trip preservation: untouched cells keep every
  field (`metadata`, `outputs`, `execution_count`, `id`, etc.), notebook-
  level `metadata` / `nbformat` / `nbformat_minor` / `kernelspec` and any
  other top-level keys are preserved verbatim. `source` is normalized to
  the canonical Jupyter `string[]` shape on write (splitting on `\n` and
  preserving the trailing `\n` on each non-final line). `change_type`
  `code → markdown` strips `outputs` + `execution_count`;
  `markdown → code` adds `outputs: []` + `execution_count: null`. Returns
  `{ ok: true, cells: <post-mutation-count> }` on success; surfaces
  validation / index-range / parse / read / write failures as
  `{ error: '<diagnostic>' }` (tool-error path — the model sees the
  error and can recover, no throws). Wired into `allTools()` as the
  eleventh client tool; the agent's default tool set now ships with 11
  client tools. (Phase 4.3)
- New `task_create` / `task_update` client tools — in-run task tracking
  surfaced through the `Notification` hook so a host UI can render
  progress. `task_create` inputs: `content` (string, required) + optional
  `activeForm` (present-continuous form). `task_update` inputs: `taskId`
  (required) + `state` (Zod enum: `'pending'` / `'in_progress'` /
  `'completed'` / `'cancelled'`, required) + optional `content` (rewrites
  the description only when provided). Library assigns each new task a
  UUID; `task_create` returns `{ id }`, `task_update` returns `{}` on
  success or `{ error: 'unknown task id: <id>' }` (tool-error path) for
  unknown ids. Every successful mutation emits one `Notification` hook
  with `level: 'info'`, `message: 'tasks_changed'`, and `context: { tasks:
Task[] }` (the FULL latest list, not a diff). The task list is held in an
  in-run `taskListRef` on `OpenRouterAgentRun` — ephemeral per run, never
  persisted to `state.json`, lost when the process exits. Both factories
  share the same ref via `allTools(ctx, { taskListRef, onTasksChanged })`
  so they read/write one list across turns. (Phase 4.2)
- `onTasksChanged` constructor option on `OpenRouterAgentRun` — host
  callback `(tasks: Task[]) => void` fired after every `task_create` /
  `task_update` mutation with a defensive shallow-copy of the full latest
  list. Equivalent to filtering the `Notification` hook on
  `message === 'tasks_changed'`; supply this when you don't want to
  subscribe to every Notification just to render the task list. Plumbed
  through `allTools(ctx, { onTasksChanged })`. Ignored when the caller
  supplies a custom `tools` array. (Phase 4.2)
- New public exports from the library root: `taskCreateTool`,
  `taskUpdateTool`, `TaskState`, `Task`, `OnTasksChanged`, `TaskListRef`,
  `TaskToolOptions`, `CreateTaskRequest`, `UpdateTaskRequest`,
  `TaskListChangedNotification`, `TaskCreateToolResult`,
  `TaskUpdateToolResult`. (Phase 4.2)
- New `ask_user_question` client tool — multiple-choice clarifying
  questions surfaced to a host UI during a run. Inputs: `question`
  (string), `options` (2–26 entries; each `{ label, preview? }`), optional
  `allow_free_text`, optional `timeout_ms` (default 300 000, clamped to
  600 000). The library generates a UUID `questionId` and auto-assigns
  per-option ids `'a'`–`'z'` lexicographically. The tool returns
  `{ selectedOptionId, label, freeTextAnswer? }` on success — `label`
  resolved from the request's options so the model never has to remember
  the lettering. Aborting via `signal` / `run.abort()` resolves promptly
  with `{ error: 'aborted' }`; a missing host handler returns
  `{ error: 'no host handler registered for ask_user_question' }`; a
  timeout returns `{ error: 'timed out after <ms>ms' }`. (Phase 4.1)
- `onAskUserQuestion` constructor option on `OpenRouterAgentRun` — host
  callback `(req: UserQuestionRequest) => Promise<UserQuestionResponse>`
  that powers `ask_user_question`. Plumbed through `allTools(ctx, {
onAskUserQuestion })`. Ignored when the caller supplies a custom `tools`
  array. (Phase 4.1)
- New public exports from the library root: `askUserQuestionTool`,
  `AllToolsOptions`, `AskUserQuestionToolOptions`,
  `AskUserQuestionToolResult`, `OnAskUserQuestion`, `UserQuestionRequest`,
  `UserQuestionResponse`. (Phase 4.1)
- The `Notification` lifecycle hook now fires once per
  `ask_user_question` call with `level: 'info'`,
  `message: 'ask_user_question'`, and the full request payload as
  `context`. Subscribers without a UI still observe every question.
  (Phase 4.1)
- `persistSession` constructor option on `OpenRouterAgentRun` (default
  `true`, backward-compatible). When `false`, the run swaps the
  `FileStateAccessor` for an in-memory accessor and skips every write under
  `logsRoot` — no `session.json`, no per-request `request.json`, no
  per-generation `response.json`, no `state.json`. The session is still
  tracked server-side by `sessionId`, hooks still fire, and the
  `AgentCoreEvent` stream is byte-identical to a persisted run. Trade-off:
  no resume across processes (the next process sees ENOENT for that
  sessionId under `logsRoot`), and external readers like `readSessionLog`
  (Phase 1.6) see nothing for that sessionId. (Phase 3.12)
- New `glob` client tool — recursive file finder by glob pattern, separate
  from the flat `list_directory` listing. Inputs: `pattern` (required, e.g.
  `**/*.ts`, `src/**/*.test.ts`, `*.md`), `path` (defaults to the agent
  `cwd`; relative paths resolve against `ctx.cwd`, absolute paths pass
  through), and `case_sensitive` (default `true`, Linux convention).
  Patterns support `**` (recursive across path separators, with
  zero-or-more-segments semantics when followed by `/` — `**/*.ts` matches
  both `top.ts` and `a/b/deep.ts`), `*` (per-segment wildcard, does not
  cross `/`), `?` (single non-`/` character), and `[...]` character
  classes (e.g. `[a-z]`, `[!abc]` for negation). Walk strategy: BFS by
  directory level (more even path-length distribution under truncation
  than DFS). Skips `node_modules`, `dist`, `coverage`, and any name
  starting with `.` at every depth. Honors `ctx.signal` — aborts promptly
  on cancellation between BFS levels and between directories within a
  level. Result shape: `{ pattern, path, matches: string[], matchCount,
truncated }`, with `matches` sorted lexicographically and capped at
  `MAX_MATCHES = 1000`. The `compileGlobToRegex` helper in
  `src/utils/glob.ts` was extended in place to support `?`, `[...]`
  character classes, and zero-or-more-segments matching when `**` is
  followed by `/`; patterns that don't use those features compile to the
  same regex as before.
  ([#50](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/50))
- Four optional input fields on the `grep_files` tool schema: `before_context`
  / `after_context` / `context` (context-line capture, like `grep -B`/`-A`/`-C`,
  each silently clamped to `[0, 20]`) and `type` (built-in filetype alias —
  `'ts'`, `'js'`, `'py'`, `'rust'`, `'go'`, `'java'`, `'rb'`, `'php'`, `'c'`,
  `'cpp'`, `'cs'`, `'sh'`, `'md'`, `'json'`, `'yaml'`; unknown values silently
  ignored). `type` combines with the existing `file_glob` via UNION — a file
  matches if either includes it. Plus a new `output_mode` enum (`'content'`
  default, `'files_with_matches'`, `'count'`) that projects the same scan into
  three result shapes — `content` (existing per-line matches, now with optional
  `before`/`after` arrays per match), `files_with_matches`
  (`{ files: string[]; matchCount: number; truncated: boolean }`), and `count`
  (`{ totalMatches: number; perFile: Array<{ file: string; count: number }>; truncated: boolean }`).
  The existing `MAX_MATCHES = 200` cap is honored across all three modes with
  `truncated: true` set on overflow. Mode dispatch happens at the
  result-assembly step (the scan always produces the full per-line match list
  internally); existing callers that pass none of the new fields see the
  identical pre-3.10 shape.
  ([#49](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/49))
- Two optional input fields on the `run_command` tool schema:
  `description` (free-text advisory note from the model, forwarded through
  `tool_call.input` — never gates execution, never appears in stdout/stderr)
  and `timeout_ms` (overrides the default 30s timeout). `timeout_ms` is
  clamped at `MAX_TIMEOUT_MS = 600_000` (10 minutes); when an over-cap value
  is supplied the tool emits a single `ctx.notify('warn', …, { requestedMs,
effectiveMs })` and proceeds with the clamped value (never throws). The
  existing SIGTERM + 250ms grace → SIGKILL escalation now applies to the
  timeout path as well, matching the long-standing abort-path behaviour;
  the abort path itself is unchanged. `MAX_TIMEOUT_MS` is exported from
  `src/tools/run-command.ts`. Existing callers that pass neither field see
  no behavioural change. ([#48](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/48))
- `run.messages()` method on `OpenRouterAgentRun` returning an
  `AsyncIterable<AgentMessage>` — a typed message-level view of the run
  aggregated from the underlying `AgentCoreEvent` stream. Yields a fixed
  sequence per run: `SystemMessage{subtype:'session_start'}` →
  per-turn `AssistantMessage` / `UserMessage` blocks → `ResultMessage` →
  `SystemMessage{subtype:'session_end'}`. Aggregation rules: `text_delta`s
  within a turn concatenate into a single `TextContent`; `tool_call`s within
  the same turn append `ToolUseContent` blocks to the same `AssistantMessage`
  (text and tool blocks interleave in event order — Claude SDK parity);
  `tool_result` flushes any open `AssistantMessage` and emits a `UserMessage`
  carrying one stringified `ToolResultContent`; `turn_end` flushes any open
  `AssistantMessage` (empty turns yield nothing). Abort flushes any open
  `AssistantMessage` before the terminal `ResultMessage`, so no buffered
  content is lost. New exports from the library entry point: `AgentMessage`,
  `SystemMessage`, `AssistantMessage`, `UserMessage`, `ResultMessage`,
  `TextContent`, `ToolUseContent`, `ToolResultContent`. **One consumer per
  run** — `for await (... of run)` (raw events) and `run.messages()` (typed
  messages) are mutually exclusive on the same instance; the second call
  throws (single-shot guard). Existing event-stream consumers are entirely
  unaffected. ([#47](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/47))
- `PreToolUseAction` discriminated union (`{ action: 'continue' }` /
  `{ action: 'block'; reason: string }` / `{ action: 'modify'; input: unknown }`)
  exported from the library. `onHook` handlers may now return one of these
  values from the `PreToolUse` event to short-circuit (`block`) or rewrite
  (`modify`) the tool call before `canUseTool` runs. Returning `void` /
  `undefined` (the pre-3.7 contract) is equivalent to `{ action: 'continue' }`
  — this is NOT a breaking change. Block synthesises the same
  `{ error, denied: true }` JSON shape `canUseTool`-deny already produces, so
  audit consumers see a uniform denial payload across both sources. `modify`
  flows the substituted input through `canUseTool` and the underlying tool
  while leaving the `tool_call` event payload (and `PreToolUse.input` /
  `PostToolUse.input`) untouched — modifications are invisible at the
  event-stream layer except via the eventual `tool_result`. Precedence:
  hook-`block` beats `canUseTool`-allow; `canUseTool`-`deny` beats
  hook-`continue` / `modify`. A throw from a `PreToolUse` handler is still
  logged-and-swallowed (treated as `continue`, never as `block`) — same
  safety contract as Phase 1.7. ([#46](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/46))
- Three new lifecycle hook events on `onHook`: `Setup` (fires once per
  `OpenRouterAgentRun` instance, BEFORE `SessionStart` — useful for first-run
  resource provisioning), `Stop` (fires LAST in the run, after `SessionEnd`,
  on every exit path including abort and constructor-throw — carries the final
  `status` and an optional `reason`), and `Notification` (caller-emitted; not
  auto-fired by the runtime). Documented fire order:
  `Setup` → `SessionStart` → `PreToolUse` / `PostToolUse` pairs → `SessionEnd` → `Stop`.
  Existing four hook events (`SessionStart`, `SessionEnd`, `PreToolUse`,
  `PostToolUse`) are unchanged.
  ([#45](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/45))
- `ctx.notify(level, message, context?)` on the tool execution context — a
  thin facade over `onHook({ event: 'Notification', ... })` so library code or
  custom tools can push status updates without taking a direct dependency on
  the hook callback. Available to both built-in and custom tools via the SDK
  `ToolExecuteContext` injected by the hook wrapper; undefined (no-op) when
  `onHook` is omitted, so callers can use the `ctx.notify?.(...)` form
  unconditionally. ([#45](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/45))
- `tool()` helper for building a `Tool` from a Zod schema with a typed `execute`
  callback — mirrors the Claude Agent SDK's `tool()` shape so callers porting
  from `@anthropic-ai/claude-agent-sdk` can keep the same object literal. Drops
  into `OpenRouterAgentRunOptions['tools']` unchanged and integrates with
  `canUseTool`, `onHook`, and the existing run loop. Schema-validation failures
  are surfaced as `tool_result.isError = true` instead of crashing the run.
  ([#44](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/44))
- `createSdkMcpServer({ name, version, tools })` factory returning an
  in-process `{ name, version, tools }` value bag — matches the Claude Agent
  SDK shape so host code can build against the eventual MCP surface. Real MCP
  transports (stdio / HTTP+SSE / `.mcp.json` discovery) come in Phase 5.2.
  ([#44](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/44))
