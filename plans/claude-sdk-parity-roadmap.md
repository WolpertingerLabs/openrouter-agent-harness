# Plan: Claude Agent SDK Parity Roadmap

> Forward-looking implementation plan for closing the remaining 36 non-Full parity gaps identified in [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md). Continues the phase sequence established by [`callboard-compatibility.md`](./callboard-compatibility.md): Phase 0 (tooling), Phase 1 (library refactor + coverage), Phase 2 (callboard adapter, deferred). **This plan defines Phase 3, Phase 4, and the Phase 5 spike list.**

Status: **Phases 0 + 1 + 3 + 4 complete as of 2026-05-24.** Phase 2 (callboard adapter) still deferred to the callboard repo. **Phase 5 is the active phase**: spikes 5.S1 (message history), 5.S2 (streaming input) with workaround design, 5.S3 (effort param) with **Yes** verdict, 5.2.S1 (MCP vendor) with **Vendor** verdict, and 5.S4 (skills/commands/plugins) with **converged-loader + 5.7 → 5.6 → 5.8** verdict — all five spikes resolved; the gated build cards (5.1–5.8) are not yet carded on the project board.

---

## Why this exists

After Phase 1, the library has the primitives (`canUseTool`, `onHook`, `signal`, `instructions`, `tools` arg, `accountInfo`/`supportedModels`) but lacks the named layers, discovery, and ergonomics that the Claude Agent SDK exposes on top of equivalent primitives. The parity matrix shows 10 Full / 11 Partial / 25 Missing across 46 rows. This roadmap turns that delta into actionable cards.

Most of the **Partial** rows are partial precisely because the primitive shipped in Phase 1 and only the layer-on-top is missing. Those are the quick wins. The hard items are clustered in three architectural questions that need spike-investigation before any commitment.

---

## Buckets

The 36 non-Full rows sort into four buckets:

- **Bucket A — Layer-on-top** (~50h, low risk). Primitive already shipped; we wrap it with config/discovery/named modes/ergonomics. → **Phase 3**
- **Bucket B — Net-new features** (~70h, moderate risk). Standalone implementations; each is a self-contained card or two. → **Phase 4**
- **Bucket C — Hard / contingent** (~50–120h, **high risk**). Requires upstream-SDK investigation first. → **Phase 5 (spike then build)**
- **Bucket D — Out of scope.** Skills, slash commands, plugins. These are Claude **Code** (CLI app) features, not Claude SDK API features. Host (callboard) owns equivalents. **Will not implement in this library.**

Bucket D rationale: the library is consumed by a host application. The host already has its own skills/commands/plugin systems (callboard's plugin architecture). Duplicating those at the library level would either fork from the host's behavior or shadow it. Closing those rows in the parity matrix should be marked **"out of scope — host responsibility"** rather than implemented.

---

## Phase 3 — Layer-on-top (~50h, 12 cards)

All builds-on items reference primitives already shipped. Most are independent and can be picked in any order subject to the sequencing rules at the bottom of this doc.

| Card     | Title                                                                                                                                                   | Builds on                      | Est.   | Depends on   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ | ------------ |
| ~~3.1~~  | ~~Named permission modes (default/acceptEdits/bypassPermissions)~~ ([#65](https://github.com/WolpertingerLabs/openrouter-agent-harness/pull/65))             | ~~`canUseTool` (Phase 1.4)~~   | ~~4h~~ | ~~—~~        |
| ~~3.2~~  | ~~`allowedTools` / `disallowedTools` config syntax (`Bash(npm *)`)~~ (PR pending)                                                                       | ~~`canUseTool` + 3.1~~         | ~~3h~~ | ~~3.1~~      |
| ~~3.3~~  | ~~Plan mode (read-only tool filter)~~ ([#68](https://github.com/WolpertingerLabs/openrouter-agent-harness/pull/68))                                          | ~~`canUseTool` + 3.1~~         | ~~1h~~ | ~~3.1~~      |
| ~~3.4~~  | ~~CLAUDE.md / `.claude/` auto-discovery → `instructions`~~ (PR pending)                                                                                 | ~~`instructions` (Phase 1.5)~~ | ~~4h~~ | ~~—~~        |
| ~~3.5~~  | ~~`tool()` helper + Zod-schema convenience + SDK-MCP-shaped helper~~ (PR pending)                                                                       | ~~`tools` arg (Phase 1.2)~~    | ~~5h~~ | ~~—~~        |
| ~~3.6~~  | ~~Remaining lifecycle hooks: `Stop`, `Setup`, `Notification`~~ (PR pending)                                                                             | ~~`onHook` (Phase 1.7)~~       | ~~5h~~ | ~~—~~        |
| ~~3.7~~  | ~~Block-and-modify hook capability (`PreToolUse` can short-circuit)~~ (PR pending)                                                                      | ~~`onHook` + `canUseTool`~~    | ~~6h~~ | ~~3.1, 3.2~~ |
| ~~3.8~~  | ~~Rich message stream (typed `AssistantMessage` etc.)~~ (PR pending)                                                                                    | ~~`AgentCoreEvent`~~           | ~~6h~~ | ~~—~~        |
| ~~3.9~~  | ~~Enhanced Bash: description field, configurable timeout~~ (PR pending)                                                                                 | ~~`run_command`~~              | ~~2h~~ | ~~—~~        |
| ~~3.10~~ | ~~Enhanced Grep: `-A`/`-B`/`-C`, filetype filters, output modes~~ (PR pending [#49](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/49)) | ~~`grep_files`~~               | ~~4h~~ | ~~—~~        |
| ~~3.11~~ | ~~Glob tool (new, separate from `list_directory`)~~ (PR pending [#50](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/50))               | ~~_new_~~                      | ~~3h~~ | ~~—~~        |
| ~~3.12~~ | ~~`persistSession: false` (in-memory only sessions)~~ (PR pending [#51](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/51))             | ~~`FileStateAccessor`~~        | ~~3h~~ | ~~—~~        |

**Phase 3 total:** ~50h.

**Initial Ready state on the project board** (no prereqs within Phase 3): 3.1, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11, 3.12 (9 cards). **Backlog until prereq lands:** ~~3.2~~ (now Done), ~~3.3~~ (now Done), ~~3.4~~ (now Done), ~~3.5~~ (now Done), ~~3.6~~ (now Done), ~~3.7~~ (now Done), ~~3.11~~ (now Done).

---

## Phase 4 — Net-new features (~70h, 9 cards)

Each is a self-contained implementation. Sequencing matters only within the subagent sub-tree (4.7 → 4.8/4.9). All other cards are independent.

| Card    | Title                                                                                                                 | Est.    | Risk                 | Depends on |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- | ---------- |
| ~~4.1~~ | ~~AskUserQuestion tool~~ ([#52](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/52))                   | ~~4h~~  | ~~host-UI contract~~ | ~~—~~      |
| ~~4.2~~ | ~~TaskCreate / TaskUpdate tools~~ ([#53](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/53))          | ~~8h~~  | ~~host-UI contract~~ | ~~—~~      |
| ~~4.3~~ | ~~NotebookEdit tool~~ ([#54](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/54))                      | ~~10h~~ | ~~low~~              | ~~—~~      |
| ~~4.4~~ | ~~Monitor tool (background-script watch)~~ ([#55](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/55)) | ~~10h~~ | ~~low~~              | ~~—~~      |
| ~~4.5~~ | ~~Session forking~~ ([#56](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/56))                        | ~~8h~~  | ~~low~~              | ~~—~~      |
| ~~4.6~~ | ~~File checkpointing~~ ([#57](https://github.com/WolpertingerLabs/openrouter-agent-harness/issues/57))                     | ~~12h~~ | ~~moderate~~         | ~~—~~      |
| ~~4.7~~ | ~~Subagent system — basic, sequential~~ ([#88](https://github.com/WolpertingerLabs/openrouter-agent-harness/pull/88))      | ~~15h~~ | ~~moderate~~         | ~~—~~      |
| ~~4.8~~ | ~~Subagent tool / model / effort overrides~~ ([#89](https://github.com/WolpertingerLabs/openrouter-agent-harness/pull/89)) | ~~5h~~  | ~~moderate~~         | ~~4.7~~    |
| ~~4.9~~ | ~~Parallel subagent execution~~ ([✅ #90](https://github.com/WolpertingerLabs/openrouter-agent-harness/pull/90))           | ~~7h~~  | ~~moderate~~         | ~~4.7~~    |

**Phase 4 total:** ~70h (estimate; 4.7 is the largest single card and most likely to slip).

**Initial Ready state:** none — Phase 4 cards stay **Backlog** until Phase 3 substantially complete (mirroring the Phase 0 → Phase 1 gate from `callboard-compatibility.md`). Once Phase 3 is ≥80% Done, promote the independent Phase 4 cards (4.1–4.7) to Ready.

**Cards involving host-UI contracts (4.1, 4.2):** before implementation, agree on the event/payload shape the host expects. Both tools surface a request that callboard must render and respond to; the library can't unilaterally define that protocol. Document the contract in the issue body before opening the implementation PR.

**`ToolSearch` deferred.** Originally Bucket B item B5 — it depends on having an MCP server with many tools to search across, which is itself Bucket C (Phase 5). Carded as a Phase 5 follow-on, not Phase 4.

---

## Phase 5 — Hard / contingent (spike before commit)

Four architectural areas needed investigation before we could responsibly size them. Each spike is a small standalone card (1–5h of research + a short write-up). Three are complete; one remains.

| Spike      | Question                                                                                              | Verdict + refined estimate                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.S1       | Does `@openrouter/agent` expose the message history (vs only `previousResponseId`)?                   | ✅ Yes — ~~15–25h~~ **12–18h** compaction ([spike](./spikes/5.S1-message-history.md))                                                                                                                         |
| 5.S2       | Does `@openrouter/agent` `callModel` accept mid-call message injection for streaming-input semantics? | ✅ No (workaround exists) — ~~10–20h~~ **16–24h** facade ([spike](./spikes/5.S2-streaming-input.md))                                                                                                          |
| 5.S3       | Does OR's API accept an `effort` / reasoning-depth parameter?                                         | ✅ Yes (normalized enum) — ~~~5h~~ **3–5h** passthrough ([spike](./spikes/5.S3-effort.md))                                                                                                                    |
| ~~5.S4~~   | ~~Claude Code's plugin / skill / slash-command architecture — what's the SDK-surface shape?~~         | ✅ Resolved — converged-loader verdict; reorder to 5.7 → 5.6 → 5.8 ([spike](./spikes/5.S4-skills-commands-plugins.md))                                                                                        |
| ~~5.2.S1~~ | ~~Should the MCP client depend on `@modelcontextprotocol/sdk` or roll our own transports?~~           | ✅ Vendor — ~~`5.2.1: 8h` / `5.2.2: 8h`~~ **`5.2.1: 3–4h` / `5.2.2: 4–5h`** ([spike](./spikes/5.2.S1-mcp-vendor.md)). MCP series shipped end-to-end via PRs #115 / #116 / #117 / #118 / #103 (5.2.1 → 5.2.5). |

**Full build-out items** (gated on the spikes — Card 5.2 split into sub-cards because the original 30–50h estimate is too large for one PR):

| Card      | Title                                              | Est.                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~5.1~~   | ~~Context compaction (post-5.S1)~~                 | ~~12–18h~~           | ~~History exposure confirmed via `ConversationState.messages` ([spike 5.S1](./spikes/5.S1-message-history.md)). Token counting via char-length heuristic for v1; includes PreCompact hook.~~ ✅ shipped — `compactionThreshold` / `keepRecentTurns` / `autoCompact` ctor opts, `OpenRouterAgentRun.compact()` method, `PreCompact` hook, `getModelContextWindow()` helper. Char-length heuristic for v1; isolated single-shot summarizer at `<sessionId>:compact:<uuid>`; `previousResponseId` cleared on rewrite (PR backlinked from card 5.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ~~5.2.1~~ | ~~MCP transport: stdio (post-5.2.S1)~~             | ~~8h~~ **3–4h**      | ~~Thin adapter over `@modelcontextprotocol/sdk`'s `StdioClientTransport` + `Client` (vendor decision per [5.2.S1](./spikes/5.2.S1-mcp-vendor.md)). Surfaces subprocess lifecycle + `stderr` piping.~~ ✅ shipped — `McpStdioClient` in `src/mcp/transport-stdio.js`. SDK lazy-loaded inside `connect()`. PR #115.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ~~5.2.2~~ | ~~MCP transport: HTTP + SSE (post-5.2.S1)~~        | ~~8h~~ **4–5h**      | ~~Thin adapter over `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` (+ deprecated `SSEClientTransport` for back-compat with servers that haven't migrated) — vendor decision per [5.2.S1](./spikes/5.2.S1-mcp-vendor.md).~~ ✅ shipped — `McpHttpClient` in `src/mcp/transport-http.js`, discriminated `{ transport: 'streamableHttp' \| 'sse' }` options. PR #116.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ~~5.2.3~~ | ~~MCP `.mcp.json` config discovery (post-5.2.S1)~~ | ~~5h~~               | ~~Project + user-level config file loading, server-spec validation.~~ ✅ shipped — `loadMcpConfig()` in `src/mcp/config.ts`, scopes `'user'` (`<os.homedir()>/.mcp.json`) + `'project'` (walk up to first `.git`, depth 10). Discriminated-union output (`stdio` / `http`) inferred from `command`/`url` presence; per-entry `source` path stamped for debuggability. Project entries override user entries by name (full replacement). Not wired into `OpenRouterAgentRun` yet — bridge (5.2.4) + lifecycle hooks (5.2.5) follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ~~5.2.4~~ | ~~MCP tool-bridge (post-5.2.1, 5.2.2, 5.2.3)~~     | ~~8h~~               | ~~Expose MCP-server tools as `Tool[]` to the agent loop; map MCP tool schemas → our `Tool` shape.~~ ✅ shipped — `McpBridge` in `src/mcp/bridge.ts`, lazy per-run pool that spawns each server, lists tools, and surfaces them on the agent's `Tool[]` under the prefixed name `<server>__<tool>`. Schema-passthrough via `z.unknown().meta(...)` (JSON Schema reaches the model verbatim). New ctor opts `mcpServers?` + `autoDiscoverMcp?` (default `false`); init failures log + fire `Notification` hook + continue with surviving servers. PR #118.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ~~5.2.5~~ | ~~MCP lifecycle hooks + integration (post-5.2.4)~~ | ~~6h~~               | ~~`McpServerStart` / `McpServerStop` hooks; full-stack integration tests; README + parity-matrix docs.~~ ✅ shipped — `McpServerStart` / `McpServerStop` payloads in `src/events.ts`, bridge fires from `init()` / `close()` (capability counts on start; `reason ∈ {'closed', 'error', 'aborted'}` + `durationMs` on stop), agent wires the lifecycle emitter to `safeFireHook`, integration suite under `src/__tests__/integration/mcp/`. PR #103.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ~~5.3~~   | ~~Streaming input mode (post-5.S2)~~               | ~~16–24h~~           | ~~Mid-call message injection infeasible at SDK/wire layer (SSE one-way); ship Claude-SDK-shaped `AsyncIterable<UserMessage>` + `interrupt()` facade over OR's `interruptedBy` resume primitive.~~ ✅ shipped — `OpenRouterAgentRunOptions.prompt: string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | AsyncIterable<UserInput>`+`OpenRouterAgentRun.pushUserMessage(msg)`+`OpenRouterAgentRun.interrupt()`. Multi-turn restart loop in `src/agent.ts`carries`messages`+`partialResponse`across cycles via the existing`StateAccessor`; interrupted partial assistant text is committed as an assistant message before the next user input. Image / file attachments ride on `UserInput.content: ContentBlock[]` (lenient passthrough). PR #104. |
| ~~5.4~~   | ~~Effort / reasoning level (post-5.S3)~~           | ~~3–5h~~             | ~~OR exposes a normalized `reasoning.effort` enum (`xhigh\|high\|medium\|low\|minimal\|none`); `@openrouter/agent` `callModel` already accepts it via `CallModelInput`. One-line plumbing of the existing Phase 4.8 `effort` stub into `agent.ts`.~~ ✅ shipped — `OpenRouterAgentRunOptions.effort: EffortLevel` forwarded into `callModel` as `reasoning: { effort }` only when set; per-subagent override rides the same rails (PR backlinked from card 5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ~~5.5~~   | ~~`ToolSearch` (post-5.2.4)~~                      | ~~8h~~               | ~~Dynamic tool loading from large MCP tool sets; needs the bridge from 5.2.4 first.~~ ✅ shipped — new `OpenRouterAgentRunOptions.enableToolSearch?: boolean` opt-in hides the MCP bridge's tools behind two built-in tools: `tool_search({ query, limit? })` returns ranked matches over `bridge.catalog` (name×10 / desc×5 / token×2/1; tie-break name lex) with a truncated `schema_preview`, and `tool_load({ names })` registers tools into a shared mutable `toolsForRun` array so subsequent turns can call them. Each load fires `Notification(info, 'tool_loaded')`. PR [✅ #NN].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ~~5.6~~   | ~~Slash commands (post-5.7)~~                      | ~~5–8h~~ **3–5h**    | ~~Flat-file `.claude/commands/<name>.md` discovery + `/<name>` resolution.~~ ✅ shipped — `createCommandLoader({ cwd, home, pluginRoots, skillLoader? })` walks `<root>/.claude/commands/*.md` across project + user + plugin scopes (project>user; plugin namespaced `<plugin>:<name>`; subdirs `<dir>:<name>`). `loader.resolve(input)` shell-splits the raw line, renders the body via the Phase 5.7 substitution helper (`disableSkillShellExecution` honored), and returns `{ name, args, body }` — host feeds `body` as the next prompt. Converged-menu fold (opencode pattern): when `skillLoader` is supplied, `list()` surfaces every skill as a `source: 'skill'` command; command wins on name collision. Unknown command → `undefined` (host shows "no such command"). PR [✅ #NN].                                                                                                                                                                                                                                                                                                                                                                  |
| ~~5.7~~   | ~~Skills system (post-5.S4)~~                      | ~~8–12h~~ **10–14h** | ~~`.claude/skills/<name>/SKILL.md` discovery + `Skill` built-in tool + listing-block system-prompt injection + shared substitution helper + `context: fork` + `allowed-tools` permission integration.~~ ✅ shipped — `createSkillLoader({ cwd, home, pluginRoots })` walks the agentskills.io-spec layout with monorepo deepest-wins semantics across user + project + plugin scopes; `OpenRouterAgentRun({ skills, skillsDir, skillDescriptionBudget, disableSkillShellExecution, skillEnv })` injects a `## Available Skills` listing into the system instructions and exposes a `skill({ name, arguments? })` built-in tool. Single-pass substitution covers `${VAR}` / `$ARGUMENTS` / `$N` / `$<name>` / `` !`cmd` `` / fenced ` ```! ``` ` (output NOT re-scanned). `context: fork` delegates through the Phase 4.7 subagent runner; per-skill `allowed-tools` narrows the run-level permission policy for the render's duration. Each successful render fires `Notification(info, 'skill_loaded', { name, source })`. PR [✅ #NN].                                                                                                                         |
| ~~5.8~~   | ~~Plugins (post-5.7, 5.6, 5.2.5)~~                 | ~~10–15h~~ **8–12h** | ~~Plugin manifest (`.claude-plugin/plugin.json`) + auto-discovery + path-aggregation composition (replace-vs-add semantics) + `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` substitution.~~ ✅ shipped — `loadPlugins({ pluginDirs, home?, logger? })` returns `LoadedPlugin[]` aggregates (`{ manifest, root, dataDir, skillRoots, commandRoots, agentRoots, hookConfigs, mcpServers }`). `OpenRouterAgentRunOptions.plugins?` ctor opt folds contributions into the skill loader (additive `skillsDir` on `pluginRoots`), MCP bridge (`<pluginName>:<serverName>` namespacing), and the substitution context (`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` resolved for plugin-shipped skills). `PluginStart` / `PluginStop` lifecycle hooks bracket every plugin (counts, not arrays, on Start; `durationMs` + `reason: 'closed'` on Stop). Per-plugin parse failures log + skip. v1 defers marketplace fetcher, `userConfig` runtime, `channels`, `dependencies`, `${CLAUDE_PLUGIN_DATA}` cleanup, themes/monitors, `bin/` PATH injection, plugin hook command execution — see [spike 5.S4](./spikes/5.S4-skills-commands-plugins.md). PR [✅ #NN]. |

**Phase 5 total:** ~85–117h across 12 build cards + 2 pending spikes.

**Phase 5 closeout (2026-05-24):** All Phase 5 cards shipped. The library now reaches full parity with Claude Code + the Agent SDK on the in-scope dimensions — skills, slash commands, plugins, MCP, hooks, subagents, streaming input, compaction, tool-search, effort, session forking, checkpoints. Deferred items (marketplace fetcher, `userConfig` keychain runtime, `${CLAUDE_PLUGIN_DATA}` lifecycle, LSP, themes/monitors, plugin hook command execution) are v2 follow-ons.

---

## Card 3.0 — Bucket D reclassification (~1h, docs-only)

Skills system, slash commands, and plugins were originally Bucket D (out of scope — host responsibility). They are now **in scope** for this library: the goal is to be a drop-in replacement for Claude Code + the Agent SDK combined, and host applications shouldn't have to reimplement these features just because they're stitching together the underlying SDK pieces.

Card 3.0 closes the bookkeeping debt — updates parity matrix row descriptions and removes the Bucket D framing in this roadmap. The actual feature implementations live in Cards 5.6 / 5.7 / 5.8 (gated on the 5.S4 spike).

---

## Workflow & gates

Carrying forward the patterns established in `callboard-compatibility.md`:

### Fast-track merge

This project remains **fast-tracked**. Every Phase 3 / 4 / 5 PR may be reviewed-and-merged by the assigned coder agent / Claude session, provided all gates hold:

- Reviewer-agent verdict clean (or direct review-pass with `gh pr diff` + code-trace)
- CI green (`statusCheckRollup` SUCCESS) AND `mergeStateStatus: CLEAN` AND `mergeable: MERGEABLE`
- PR scope matches the issue (no surprise files outside the declared scope)
- Final independent diff scan by the merger
- **All hard invariants hold** (see below)

If any gate fails or uncertainty exists on any axis, leave for Ben.

### Hard invariants (verified at every merge)

Grep-clean in non-test `src/`:

- No `process.env` reads (constructor-default reads are OK; see Phase 1.5).
- No `console.*` calls.
- No `process.exit` / `process.stdin` / `readline` usage.
- `bin` field absent from `package.json`.
- `process.cwd` usage: exactly 1 occurrence (currently `src/agent.ts:411` — line drifts as `agent.ts` grows; greppable as `process\.cwd\(`). Cards adding a new tool may need to negotiate this; in general, prefer `ctx.cwd` over `process.cwd()`.
- `git diff main -- src/ ':!**/*.test.ts' ':!src/__tests__/**'` shows exactly the production changes declared in the PR body.

### Coverage gate

**Coverage thresholds stay at `96 / 92 / 94 / 98` minimum.** Each card has a per-card expectation:

- **Tool-adds and pure-feature cards (most of Phase 3 + 4):** ratchet at least one axis by ≥0.5pp. New code must be tested at least to the gate floor (no carve-outs).
- **Refactor cards (e.g., 3.7 block-and-modify hooks):** must not regress any axis. New tests should match line-for-line the new code paths.
- **Infrastructure cards (e.g., 3.12 persistSession, 4.5 session forking):** preserve gate; ratchet if natural.

If a card would regress coverage, the PR body must explicitly identify which lines are uncovered and why (defensive paths, race-flaky, etc.) — same convention as Phase 1.14's coverage panel.

### Testing patterns

Established patterns to reuse:

- **FS error fallback coverage** — `chmod 000` with `finally` restore (see `src/state/file-state.test.ts:283` and `src/tools/grep-files.test.ts:246`). Skip on `process.getuid?.() === 0` and `win32`.
- **Integration tests** — fixture-driven via `src/__tests__/integration/mock-openrouter.ts`. Add a new fixture JSON for any new event-flow scenario; extend the mock's `FixtureStep` shape if needed (see Phase 1.15's `sdkOmitsCallId` extension).
- **API helper tests** — recorded fixtures under `src/__tests__/fixtures/openrouter-api/`. Wrong-type and 401/403 paths are first-class test scenarios.
- **Tool tests** — colocated `src/tools/<name>.test.ts`. Each new tool ships with its own test file.

### Reference implementations (use freely for inspiration)

When stuck on a design call or implementation detail, implementing agents are explicitly authorized to consult the following open-source reference implementations. Pattern-match what they do; don't blindly copy.

- **Claude Code source** — Anthropic open-sourced parts of Claude Code. The Agent SDK shape (`tool()`, hooks, permission modes, message-stream types) is the authoritative parity target. Check both their public SDK examples and any internal reference shipped in their open release.
- **opencode** ([sst/opencode](https://github.com/sst/opencode)) — community-built Claude-Code-alike with its own takes on subagents, MCP integration, and the tool ergonomics layer. Particularly useful for Cards 3.5 (`tool()` helper), 4.7 (subagent system), and 5.2 (MCP server support).
- **codex** ([openai/codex](https://github.com/openai/codex)) — OpenAI's open-source CLI. Shares the same problem space (agent loop, tool ergonomics, session persistence) under a different SDK. Useful for cross-checking design calls that aren't Anthropic-specific.

**When to consult them:**

- A Claude SDK feature's behavior is ambiguous from docs alone → check Claude Code source first.
- Stuck on `tool()` / MCP / subagent shape → cross-reference opencode's approach.
- Cross-vendor design pattern (file checkpointing, session forking, message streams) → check both opencode and codex for convergent patterns.

**What to avoid:**

- Copy-pasting code wholesale — license-mix risk. Read for ideas; write fresh implementations.
- Adopting a divergent design just because a reference uses it — the Claude SDK shape is the parity target; deviating needs a justified reason.
- Skipping the spike doc for Phase 5 items just because you saw how opencode/codex did it. The spike is a contract record that the build estimate has a basis.

### README + docs maintenance

Every user-facing card must include a documentation update in the same PR:

1. **README.md** — update constructor-options table, event-type table, tool table, or examples as needed.
2. **`plans/claude-agent-sdk-parity.md`** — update the matrix row for the feature being landed (`None`/`Partial` → `Full`, or refine description).
3. **This roadmap (`claude-sdk-parity-roadmap.md`)** — strike through the card row with PR number, matching the convention used in `callboard-compatibility.md` Phase 1.11–1.15 subsection.
4. **`CHANGELOG.md`** — append an `[Unreleased].Added` (or `.Changed` / `.Fixed`) entry per card. Convention established in Phase 3 and maintained through Phase 4.9.

---

## Sequencing rules

The plan's phases have hard dependencies. Don't pull a Ready card whose prerequisite isn't Done.

- **Phase 3 → Phase 4** (historical): Phase 4 stayed Backlog until Phase 3 was ≥80% Done. Both phases are now complete.
- **Within Phase 3** (historical): per-card `Depends on` column.
- **Within Phase 4** (historical): 4.8 / 4.9 depended on 4.7.
- **Phase 5 spikes (5.S1 / 5.S2 / 5.S3 / 5.S4 / 5.2.S1)**: can run any time, in parallel with build work, since they're investigation-only. Sub-spikes (5.S4, 5.2.S1) gate their respective sub-card sets.
- **Phase 5 builds**:
  - **5.1** post-5.S1 ✅ (Ready)
  - **5.2.S1** sub-spike independent (Ready)
  - **5.2.1 / 5.2.2 / 5.2.3** post-5.2.S1 (Backlog)
  - **5.2.4** post-5.2.1 + 5.2.2 + 5.2.3 (Backlog)
  - **5.2.5** post-5.2.4 (Backlog)
  - **5.3** post-5.S2 ✅ + post-5.1 (StateAccessor surface; Backlog)
  - ~~**5.4** post-5.S3 ✅ (Ready)~~ ✅ shipped
  - **5.5** post-5.2.4 (Backlog — needs the tool-bridge)
  - ~~**5.S4** independent spike (Ready)~~ ✅ resolved
  - **5.7** post-5.S4 ✅ (Ready — build first per [spike 5.S4](./spikes/5.S4-skills-commands-plugins.md))
  - **5.6** post-5.7 (Backlog — reuses skill loader + substitution helper)
  - **5.8** post-5.7 + 5.6 + 5.2.5 (Backlog — composes skills + commands + MCP)
- **Card 3.0 (Bucket D reclassification)**: independent docs micro-card (Ready).

**One in-flight coder session per repo at a time.** Same rule as Phase 1. When a card moves to Done, scan Backlog for the next unblocked card and move it to Ready.

---

## Total roadmap estimate

| Phase               | Effort (est.)  | Status                                                                                                          |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Phase 3             | ~50h           | ✅ Complete (12 cards, fast-track-merged 2026-05-22 → 2026-05-23).                                              |
| Phase 4             | ~70h           | ✅ Complete (9 cards, fast-track-merged 2026-05-23 → 2026-05-24).                                               |
| Phase 5             | ~85–117h       | 3 of 4 spikes complete; 12 build cards + 2 pending spikes + 1 micro-card carded.                                |
| Bucket D            | _reclassified_ | Skills / SlashCommands / Plugins reclassified IN-scope (Cards 5.6 / 5.7 / 5.8); see Card 3.0.                   |
| **Total remaining** | **~85–117h**   | Phase 5 only — Phases 3 + 4 done. ~2–3 weeks at current fast-track throughput (~3 merges/day when cooperative). |

---

## Companion docs

- [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) — the parity matrix this roadmap closes.
- [`callboard-compatibility.md`](./callboard-compatibility.md) — Phase 0/1/2 plan, fast-track gate conventions, hard invariants.
- The GitHub Issues tracker — live status. Cards are sourced from this roadmap.
