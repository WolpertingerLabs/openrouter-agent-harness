# Plan: Callboard Compatibility

Make openrouter-agent-harness consumable by [callboard](https://github.com/WolpertingerLabs/callboard) as a third `AgentProvider` + `SessionProvider`, alongside the in-tree `claude-code` adapter and the planned `codex` adapter.

Status: **Phase 0 + Phase 1 complete (18 PRs merged, through Phase 1.15 on 2026-05-22).** Phase 2 (callboard adapter, ~40h) deferred — lands separately in the callboard repo whenever the integration becomes a priority. See the [Implementation Order](#implementation-order) section below for the per-card breakdown and final coverage numbers.

Pre-requisites landed in callboard via PR #125 (`AgentProvider`) and PR #126 (`SessionProvider`). The codex adapter (callboard's `plans/codex-adapter.md`) is the closest worked example to mirror.

Companion docs:

- This repo: [`plans/claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) — feature gap vs Anthropic SDK; overlap with this plan called out below.
- Callboard: `plans/agent-abstraction-layer.md` — defines the ports we must implement.
- Callboard: `plans/codex-adapter.md` — concrete worked example of an adapter; this plan follows the same shape.
- Callboard: `deep-research-claude-agent-sdk-alternatives.md` — section on `@openrouter/agent` flagging MCP gap as the primary risk for this pairing.

---

## Goal

**This repo is becoming a library.** No CLI entrypoint, no REPL, no piped/single-prompt modes. Its sole purpose is to be imported by callboard (and any future consumer) as a drop-in replacement for `@anthropic-ai/claude-agent-sdk`.

Two halves of the deliverable:

1. **Library shape** — refactor `src/` so the agent core is a single async-iterable class with no CLI scaffolding, no `process.env` reads, no console output, no readline.
2. **Adapter wiring** — provide an `OpenRouterAdapter` (`AgentProvider`) and `OpenRouterSessionProvider` (`SessionProvider`) that conforms to callboard's ports. Adapter lives in callboard (`backend/src/agents/adapters/openrouter/`), mirroring the codex/claude-code shape. This repo exports a programmatic surface explicitly designed to be wrapped thinly.

### What CLI-only-removal lets us delete outright

- `AgentSession` / `createAgent` / `runPrompt` triad — collapses into one `OpenRouterAgentRun` class. The split exists today so a REPL can reuse one OR client across prompts; library callers create a fresh run per query.
- The ~80 lines of CLI display logic in `agent.ts:112-265` — `truncate`, `callSnippet`, `resultSnippet`, turn-banner emission, ⚙/↳ formatting, `turnHadText`/`lastCharInTurn` state. All terminal-rendering.
- `src/logging/session-registry.ts` + `sessions.json` — pure CLI affordance for `--continue` last-session lookup. Library callers always pass an explicit `sessionId`.
- All readline / stdin TTY detection / exit-code logic in `src/index.ts`.
- Every `process.env` read at module load (`agent.ts:21-23`, `agent.ts:25-35`, etc.) — adapter passes everything via constructor opts. `.env.example` becomes test-fixture documentation only.
- The `bin` field and CLI-specific entries in `package.json`.
- The coverage-threshold exclusion for `src/index.ts` — index.ts is library code now, fully testable.

---

## Current State

What already maps cleanly to callboard's `AgentProvider` shape:

| Callboard expectation                            | Current state in this repo                                                           | Verdict                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `query()` returns an async-iterable event stream | `runPrompt()` returns `Promise<PromptResult>` and streams via `onTextDelta` callback | ✗ Reshape to async-iterable (and delete the callback path entirely — no CLI consumer remains) |
| Session ID stable across turns                   | `AgentSession.sessionId` + `previousResponseId` via `FileStateAccessor`              | ✓ (sessionId becomes a constructor arg; the `AgentSession` wrapper goes away)                 |
| Resume by session ID                             | `OR_SESSION_ID` env var or `--continue` flag → `createAgent(id)`                     | ✓ (mechanism exists; library form is just a constructor arg — env/flag plumbing deleted)      |
| Cost tracking                                    | `promptCost` accumulated via `onTurnEnd`; `usage.cost` per turn                      | ✓                                                                                             |
| Turn counting                                    | `turnCount` via `TurnStartEvent.turnNumber`                                          | ✓                                                                                             |
| Stop conditions                                  | `stepCountIs(MAX_STEPS)`, `maxCost(MAX_COST)`                                        | ✓                                                                                             |
| Tool calls/results visible in stream             | `response.output_item.done` + `isToolCallOutputEvent`                                | ✓                                                                                             |
| Persistent disk logs                             | `logs/<session>/<request>/<gen>/response.json`                                       | ✓ (good basis for `SessionProvider`)                                                          |
| Session preview / first user message             | Captured in `session.json` per-request log                                           | ✓ (parseable)                                                                                 |
| Permission system                                | None — all tools run unconditionally                                                 | ✗                                                                                             |
| MCP / external tool servers                      | None — tools hardcoded in `src/tools/`                                               | ✗ (biggest gap)                                                                               |
| Compile-time event types                         | Raw `@openrouter/agent` events                                                       | ✗ Need translation layer                                                                      |
| Lifecycle hooks (PreToolUse, PostToolUse)        | `onTurnEnd` only                                                                     | ✗                                                                                             |
| Interrupt / abort                                | Not exposed                                                                          | ✗                                                                                             |
| `accountInfo()` / `supportedModels()`            | Not implemented                                                                      | ✗                                                                                             |

The good news: the agent-loop substrate (sessions, persistence, streaming, cost, turns) is solid. The gaps are mostly **shape** (callback → async-iterable, hardcoded → injectable) rather than **substance** (no compaction logic, no auth flow, etc.).

---

## Required Changes

### 1. Library entrypoint

`src/` becomes a single flat library surface. No CLI, no shim. Existing tools/ and state/ stay where they are; the rest collapses.

```
src/
  agent.ts             # OpenRouterAgentRun class — implements AsyncIterable<AgentCoreEvent>, has abort()
  events.ts            # AgentCoreEvent union (intermediate; adapter translates to callboard AgentEvent)
  types.ts             # Public types
  openrouter-api.ts    # accountInfo() + supportedModels() helpers (see §10)
  tools/               # unchanged (5 client + 3 server tools)
  logging/
    logger.ts          # unchanged
    # session-registry.ts DELETED — CLI affordance only
  state/
    file-state.ts      # unchanged
  index.ts             # re-export package root — single line
```

**Files deleted:** `src/logging/session-registry.ts`, the existing REPL/pipe/single-prompt body of `src/index.ts`, `src/index.test.ts` (replaced by tests on the new library surface).

Key invariants for the new `src/agent.ts`:

- **One class, not three functions.** `OpenRouterAgentRun` replaces `AgentSession` + `createAgent` + `runPrompt`. Construct with `{ sessionId, prompt, instructions, model, cwd, maxTurns, maxBudgetUsd, tools, canUseTool, onHook, signal, logsRoot, apiKey, baseUrl, appTitle }`. Implements `[Symbol.asyncIterator](): AsyncIterator<AgentCoreEvent>` and exposes `abort()`.
- **No `process.env` reads at all.** All config comes through the constructor. The adapter (or any other consumer) is responsible for mapping its own env into constructor opts.
- **No `console.*` at any path.** Optional `logger?: (level, msg, fields) => void` constructor option for the rare diagnostic path.
- **No `process.exit`.** Errors thrown / emitted as `result { status: "error" }` events.
- **No display formatting.** The `truncate` / `callSnippet` / `resultSnippet` / `⚙` / `↳` / turn-banner logic in `agent.ts:112-265` is deleted outright. Consumers get raw `tool_use` / `tool_result` events and render however they want.

`package.json` exports a single library entry. Drop `bin` field. Drop `OR/Agent Harness` hardcoded `appTitle` from the OR client constructor — accept it as a constructor option instead, default to `"openrouter-agent-harness"`.

### 2. AgentProvider implementation

The adapter (in callboard) imports `OpenRouterAgentRun` and wraps it:

```ts
// backend/src/agents/adapters/openrouter/OpenRouterAdapter.ts (in callboard)
class OpenRouterAdapter implements AgentProvider {
  readonly kind = 'openrouter' as const; // requires AgentProviderKind union extension

  constructor(
    private opts: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      env?: Record<string, string>;
    },
  ) {}

  query(req: AgentQueryRequest): AgentQuery {
    const run = new OpenRouterAgentRun({
      ...this.opts,
      ...translateOptions(req.options),
      prompt: req.prompt,
    });
    return new OpenRouterAgentQuery(run);
  }

  buildToolServer(spec: ToolServerSpec): unknown {
    // Translate callboard ToolDefinition[] → @openrouter/agent tools (see §6)
  }
}
```

`OpenRouterAgentQuery` is `AsyncIterable<AgentEvent>` + `accountInfo()` + `supportedModels()` + `close()`. Internally drives `OpenRouterAgentRun` and translates `AgentCoreEvent` → callboard `AgentEvent`. `close()` calls `run.abort()`.

This requires **this repo** to expose:

- `OpenRouterAgentRun` class — `AsyncIterable<AgentCoreEvent>` + `abort()`. Constructor takes everything (no env, no globals).
- `AgentCoreEvent` union — typed wrapper around the raw OR stream (text delta, turn start, turn end, tool call, tool result, error, stream complete).

### 3. Event translation table

This repo's `AgentCoreEvent` → callboard's `AgentEvent`:

| AgentCoreEvent (this repo)                              | Callboard AgentEvent                                        | Notes                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `session_started { id }` (synthesized at run() start)   | `session_started { sessionId }`                             | Emit eagerly from constructor (OR session IDs are client-generated, available before first turn) |
| `text_delta { content }`                                | `text { content }`                                          | One AgentEvent per delta; coalescing not required (callboard handles)                            |
| `turn_start { turnNumber }`                             | (none — callboard doesn't have a turn event)                | Drop, or surface as `adapter_specific` if useful for UI                                          |
| `tool_call { callId, name, input }`                     | `tool_use { callId, toolName, input }`                      | Field rename                                                                                     |
| `tool_result { callId, output, isError }`               | `tool_result { callId, content, isError }`                  | Stringify `output` to `content: string` per port shape (`events.ts:33`)                          |
| `turn_end { usage, cost }`                              | accumulate into pending `result.usage`; don't emit per-turn | Final `result` event carries totals                                                              |
| `stream_complete { status, reason, usage, durationMs }` | `result { status, reason, usage, durationMs }`              | `stepCountIs` exhaustion → `max_turns`; `maxCost` exhaustion → `max_budget`; error → `error`     |
| (none — OR has no reasoning event today)                | `thinking { content }`                                      | Skip; revisit if OR adds reasoning deltas                                                        |
| (none)                                                  | `slash_commands`                                            | Skip (Claude-specific)                                                                           |
| (none)                                                  | `compaction_boundary`                                       | Skip — OR relies on `previousResponseId` for context management; no boundary signal              |
| anything else                                           | `adapter_specific { adapter: "openrouter", payload }`       | Escape hatch                                                                                     |

### 4. Options translation

Callboard passes `options: Record<string, unknown>` shaped like the Claude SDK Options. Per the codex-adapter plan, map what makes sense:

| Callboard option                   | OpenRouter equivalent                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                              | Resolve all tool path inputs against this (today tools assume CWD; need core-level base path)                                                                                           |
| `model`                            | `callModel({ model })` — default to `OR_MODEL`                                                                                                                                          |
| `maxTurns`                         | `stopWhen: [stepCountIs(maxTurns)]`                                                                                                                                                     |
| `maxBudgetUsd`                     | `stopWhen: [maxCost(maxBudgetUsd)]`                                                                                                                                                     |
| `systemPrompt` (string)            | `callModel({ instructions })` — replaces hardcoded prompt at `agent.ts:92`                                                                                                              |
| `systemPrompt` (preset+append)     | Concat into `instructions`; ignore preset (Claude-specific)                                                                                                                             |
| `resume: sessionId`                | Pass through to `OpenRouterAgentCore` constructor — already supported via `OR_SESSION_ID` mechanism                                                                                     |
| `env`                              | Apply to spawned child processes in `run_command`; merge into OR client `env` if it accepts one                                                                                         |
| `abortController`                  | `core.abort()` when aborted — needs new `AbortSignal` plumbing in core                                                                                                                  |
| `canUseTool`                       | See §5                                                                                                                                                                                  |
| `allowedTools` / `disallowedTools` | Tool filter at registration time                                                                                                                                                        |
| `mcpServers`                       | Adapter's responsibility — translate to OR tools via `buildToolServer`                                                                                                                  |
| `effort`                           | Drop (OR doesn't expose; revisit if added)                                                                                                                                              |
| `plugins` / `settingSources`       | Library-level plugin discovery via Card 5.8 (post-5.S4) — pass-through if/when callboard needs it. _Was "Drop (Claude-specific)" under pre-2026-05-24 Bucket D framing — see Card 3.0._ |
| `permissionMode`                   | Map to a permission-policy strategy applied via `canUseTool`                                                                                                                            |

The two non-trivial pieces: `cwd` (all file tools need a base-path arg, not implicit `process.cwd()`) and `abortController` (the core needs an `AbortSignal` it can honor between turns).

### 5. Permission system (P0 — also called out in `claude-agent-sdk-parity.md` §P0.1)

Callboard expects an adapter to respect a `canUseTool(toolName, input)` callback before executing client-side tools. Today this repo has none — every tool call executes unconditionally.

Required:

- `OpenRouterAgentCore` accepts an optional `canUseTool: (name, input) => Promise<{ behavior: "allow" | "deny"; reason?: string; updatedInput?: unknown }>` constructor option.
- Wrap each client tool's `execute` so that **before** the underlying handler runs, `canUseTool` is consulted.
  - `allow` → run handler, optionally with `updatedInput`.
  - `deny` → synthesize a tool result with the deny reason (mirrors Claude SDK behavior).
- Server-side tools (`web_search`, `web_fetch`, `datetime`) are out of our control — they execute on OpenRouter's side. Document this as a known limitation: callboard's web-access permission category can't gate them; the only knob is registering them at all.

### 6. Tool exposure / `buildToolServer` (biggest gap)

Callboard's `ToolServerSpec` is a bundle of `ToolDefinition`s: `{ name, description, inputSchema: ZodRawShape, handler }`. Callboard has 4 of these (`callboard`, `callboard-tools`, `mcp-proxy`, `qc`) that the adapter must expose to the running agent.

Per the abstraction-layer doc, **`@openrouter/agent` does not document MCP support**. So we can't pass MCP server configs the way Claude Code or Codex do. Two options:

**Option A — Re-wrap as plain OR tools (recommended).** Translate each `ToolDefinition` into the shape `@openrouter/agent` expects (likely Zod-schema-typed function tools), bundle into the `tools` array of `callModel`. This is purely in-process — no subprocess MCP servers, no protocol overhead.

```ts
function toolDefToOrTool(def: ToolDefinition): OrTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: z.object(def.inputSchema), // ZodRawShape → ZodObject
    execute: async (args) => {
      const result = await def.handler(args);
      // Flatten ToolCallResult.content[] → string the OR runtime expects
      return result.content
        .map((b) => (b.type === 'text' ? b.text : `[image:${b.mimeType}]`))
        .join('\n');
    },
  };
}
```

Gotchas to verify against the live SDK:

- **Zod version match.** `@openrouter/agent` ships its own internal Zod; this repo already pins to `zod/v4` per CLAUDE.md. Callboard's tool ports use `import type { z } from "zod"`. Confirm versions resolve to the same major across both packages.
- **Result content shape.** Callboard tool handlers return `{ content: ToolContentBlock[], isError? }`. OR likely expects a string or JSON. Need a translator (sketch above).
- **Image blocks.** Callboard supports `{ type: "image", data, mimeType }`. OR may or may not — start by stringifying as a placeholder; bug-bash later.
- **Tool count.** Callboard's 4 servers total ~48 tools by codex-adapter's count. Confirm OR's tool array isn't capped or hits context-window pressure; consider lazy/tool-search later (parity P2).

**Option B — Spawn callboard tool servers as MCP stdio servers, write an MCP→OR shim.** Symmetric with the codex-adapter approach but `@openrouter/agent` has no documented MCP client surface; this likely requires forking or PRing the SDK. Defer.

### 7. SessionProvider (`OpenRouterSessionProvider`)

The current `logs/<session>/...` tree maps cleanly onto callboard's `SessionProvider`:

| Method                                | Implementation against current `logs/` layout                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `discoverSessions({ limit, offset })` | `readdir logs/`, stat each `<session_id>/`, sort by mtime DESC, paginate                    |
| `resolveSession(sessionId)`           | Return `{ logPath: logs/<id>/session.json, folder: <captured>, displayFolder: <captured> }` |
| `findSubagentFiles(sessionId)`        | Return `[]` — no subagents yet (parity gap)                                                 |
| `parseSessionMessages(sessionIds[])`  | Walk `logs/<id>/<request>/<gen>/response.json`, translate OR events → `ParsedMessage[]`     |
| `getSessionPreview(logPath, max)`     | Read `session.json` (or first `request.json`) → return first user message, truncated        |
| `searchSessions(filters)`             | Grep across `logs/**/*.json` constrained by `folder`/`grep`/date filters                    |
| `deleteSessionFiles(sessionId)`       | `rm -rf logs/<sessionId>/`                                                                  |

Two changes needed in this repo to make the above work:

1. **Capture `folder` / `cwd` per session.** `logs/<id>/session.json` currently doesn't store the working directory. Add it (write at session creation in `logger.ts`). Without this, `discoverSessions` can't populate `folder` / `displayFolder`.
2. **Log root path configurability.** Today `logs/` is relative to CWD. Adapter needs to point this at a known absolute path (e.g. `~/.openrouter-agent-harness/logs/`) so the SessionProvider can scan it. Add `logsRoot` to core constructor options.

`ParsedMessage` translation is the meat — mirror codex-adapter's mapping:

| OR log shape                                   | ParsedMessage shape                         |
| ---------------------------------------------- | ------------------------------------------- |
| `request.prompt`                               | user message                                |
| `response.output[]` text items                 | assistant text message                      |
| `response.output[]` function_call items        | tool_use (with callId, name, input)         |
| `response.output[]` function_call_output items | tool_result (with callId, content, isError) |

### 8. Hooks (PreToolUse / PostToolUse / SessionStart / SessionEnd)

Callboard's port defines a neutral hook subset (per `agent-abstraction-layer.md` §Open Questions). At minimum:

- `PreToolUse` — already overlaps with `canUseTool` (§5). The hook is for _audit/side-effects_; `canUseTool` is for _decisions_. Wire both.
- `PostToolUse` — fire after each tool result, before result is emitted to the stream.
- `SessionStart` / `SessionEnd` — fire once per `run()` call.

Add `onHook(event, payload)` constructor option to `OpenRouterAgentRun`. Adapter wires callboard's neutral hook callbacks into it.

### 9. System prompt / identity

`agent.ts:92-93` hardcodes the instructions. Replace with a constructor option (`instructions` / `systemPrompt`). Callboard's `compileIdentityPrompt()` will write the final string; we just plumb it through.

### 10. `accountInfo()` and `supportedModels()`

Callboard's `AgentQuery` interface requires both. Implementations:

- `accountInfo()` — call OR's `/api/v1/auth/key` (returns label, usage, limit) or `/api/v1/credits`. Return `{ provider: "openrouter", label, usageUsd, limitUsd }` or `null`.
- `supportedModels()` — call OR's `/api/v1/models`. Map to `{ value, displayName, description }[]`.

Both can live in a small `openrouter-api.ts` module in this repo, exported for the adapter to use without re-implementing.

---

## Callboard-side change required (Phase 2)

`AgentProviderKind` (`backend/src/agents/ports/AgentProvider.ts:52`) is `"claude-code" | "codex" | "mock"`. Add `"openrouter"`. Single-line PR against callboard. Tracked as step 2.1 below.

---

## Implementation Order

Three phases. **Phase 0** is tooling bootstrap (lands first to make every subsequent PR safer). **Phase 1** is the library refactor (all in this repo). **Phase 2** is the callboard adapter (separate repo, can land any time after Phase 1 is shipped).

### Phase 0 — Tooling Bootstrap (~5h, this repo)

This repo currently has no linter, no formatter, no CI, and `src/agent.ts` is explicitly excluded from coverage. The refactor PRs will be mixing style with substance and have no enforcement floor until we fix that. Three small PRs first.

| Step | What                                                                                                                                                                                                                                                                                                                                 | Est. |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 0.1  | **Prettier setup:** add `prettier` devDep, `.prettierrc` (match this repo's existing style: 2-space, single-quote, semi, trailing-comma all), `.prettierignore` (dist/, coverage/, .test-tmp/, node_modules/, package-lock.json). Add `format` + `format:check` scripts. Run `npm run format` on the whole tree as the first commit. | 1h   |
| 0.2  | **ESLint flat config:** add `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint-config-prettier` devDeps. `eslint.config.js` with strict TS recommended + prettier-conflict-off. `lint` + `lint:fix` scripts. Fix any violations on existing code so baseline is clean.                               | 2h   |
| 0.3  | **GitHub Actions CI:** `.github/workflows/ci.yml` running on push/PR: `npm ci` → `npm run lint` → `npm run format:check` → `npm run build` → `npm test` → `npm run test:coverage`. Node 22. Cache `node_modules`. Required-check on `main`.                                                                                          | 1h   |

### Phase 1 — Library Refactor (~22h, this repo)

| Step | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Est. |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.1  | **Strip CLI:** delete REPL/pipe/single-prompt logic from `src/index.ts`, delete `src/logging/session-registry.ts` (+ its tests), delete display helpers (`truncate`/`callSnippet`/`resultSnippet`/turn banners) from `agent.ts`. Drop `bin` from `package.json`. Drop `dotenv` dep (no env reads in library code).                                                                                                                                                                                                                                                                     | 2h   |
| 1.2  | **Collapse to `OpenRouterAgentRun` + `AgentCoreEvent`:** merge `createAgent`+`runPrompt`+`AgentSession` into one class that implements `AsyncIterable<AgentCoreEvent>`. Define `AgentCoreEvent` union in `src/events.ts`. Replace `onTextDelta` callback with `yield`. Remove all `process.env` reads — constructor takes everything. Remove all `console.*` — optional `logger` callback. Expose `tools` as a constructor option with default `allTools` (the bundled 5 client + 3 server tools), so standalone consumers get a useful preset and the callboard adapter can override. | 5h   |
| 1.3  | **AbortSignal plumbing:** `signal` constructor option + `abort()` method on `OpenRouterAgentRun`. Verify the OR SDK's interrupt actually stops mid-turn, not only between turns. Tests for abort during text streaming and during tool execution.                                                                                                                                                                                                                                                                                                                                      | 2h   |
| 1.4  | **`canUseTool` callback:** constructor option `canUseTool: (name, input) => Promise<{ behavior: "allow" \| "deny"; reason?; updatedInput? }>`. Wrap each client tool's `execute` so `canUseTool` runs before the handler. `deny` synthesizes a tool_result with the reason. Tests for allow/deny/updatedInput.                                                                                                                                                                                                                                                                         | 3h   |
| 1.5  | **Constructor options refactor:** make `cwd`, `logsRoot`, `instructions`, `appTitle`, `model`, `maxTurns`, `maxBudgetUsd`, `apiKey`, `baseUrl` constructor options. Remove hardcoded `process.cwd()` from tool implementations (each tool accepts `cwd` via context). Remove hardcoded instructions string at the old `agent.ts:92`.                                                                                                                                                                                                                                                   | 3h   |
| 1.6  | **Capture `folder` in session log:** modify `logger.ts` to write `cwd` into `logs/<id>/session.json` at session-creation time. Required for the callboard SessionProvider's `discoverSessions` to populate `folder`/`displayFolder`.                                                                                                                                                                                                                                                                                                                                                   | 1h   |
| 1.7  | **`onHook` lifecycle callback:** constructor option `onHook(event, payload)` firing for `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`. Tests verifying each fires at the right moment.                                                                                                                                                                                                                                                                                                                                                                                     | 3h   |
| 1.8  | **`openrouter-api.ts` helpers:** `accountInfo()` calling `/api/v1/auth/key` or `/api/v1/credits`; `supportedModels()` calling `/api/v1/models` and mapping to `{ value, displayName, description }[]`. Tests against recorded fixtures.                                                                                                                                                                                                                                                                                                                                                | 3h   |
| 1.9  | **Coverage re-inclusion + integration-test scaffold:** remove `src/agent.ts` and `src/index.ts` from the `vitest.config.ts` coverage exclusion list. Add `src/__tests__/integration/` with a helper for mocking `@openrouter/agent` from recorded event fixtures. One end-to-end integration test: session → multi-turn → tool gate via `canUseTool` → abort mid-stream → result event.                                                                                                                                                                                                | 4h   |
| 1.10 | **`package.json` + README:** single `main`/`types`/`exports` entry, drop `bin`, drop `dotenv` if not already done in 1.1, version bump to 0.2.0. Rewrite README around library usage; remove all CLI documentation. Document the public API surface (constructor opts, event union, helpers).                                                                                                                                                                                                                                                                                          | 2h   |

**Phase 1 total:** ~28h (Phase 0 + Phase 1 = ~33h). Up from 21h after Phase 0 + integration tests + coverage re-inclusion got folded in.

#### Phase 1.11–1.15 — Coverage stabilization (post-1.10 add-on, 2026-05-22)

After Phase 1.10 landed, four cards (1.11–1.14) were carded to close coverage gaps the original plan had left open, plus an ad-hoc 1.15 polish. All five test-only — zero production-code touched after 1.10.

| Step | What                                                                                                                                                                                                                                                              | PR  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1.11 | **`run-command.ts` cancel + kill-signal coverage.** SIGTERM-then-SIGKILL timer path, abort-during-stdio path, stderr-only capture.                                                                                                                                | #32 |
| 1.12 | **`agent.ts` error-path coverage.** Permission-denial synth-deny payload, hook-throw swallowing, constructor-throw → emit error event, abort during stream, max-budget exhaustion via `maxCost` SDK arg.                                                          | #33 |
| 1.13 | **Tool FS error fallback coverage.** `chmod 000` patterns for `readdir`/`stat`/`readFile` fallbacks in `grep-files.ts`, broken-symlink skip, unreadable-file `continue`.                                                                                          | #34 |
| 1.14 | **API/state edges + raise coverage thresholds.** `openrouter-api.ts` wrong-type `usage`/`limit`/`label` fallbacks; `file-state.ts` non-ENOENT rethrow via `chmod 000`. Ratcheted thresholds to 95/90/94/97.                                                       | #35 |
| 1.15 | **Coverage gate polish (ad-hoc).** Excluded `src/__tests__/**` from coverage scope (was measuring test scaffolding). Added test for `wrapToolWithHooks`'s `randomUUID` callId fallback when SDK ctx omits `toolCall.callId`. Ratcheted thresholds to 96/92/94/98. | #36 |

**Final coverage** (library scope, excluding test scaffolding): statements **97.51%**, branches **93.85%**, functions **95.45%**, lines **99.46%**. Thresholds locked at **96 / 92 / 94 / 98** (1.45–1.85pp buffer per axis). 166 tests, all green on CI.

**Hard invariants verified at every merge** (grep-clean in non-test `src/`): no `process.env` reads, no `console.*`, no `process.exit`/`process.stdin`/`readline`; `bin` absent from `package.json`; `process.cwd` exactly once at `src/agent.ts:154`.

**Coverage gaps deliberately left** (diminishing returns):

- `agent.ts:547,620` wrapper early-returns when SDK tools have no local `execute` — defensive type guard, no realistic library-consumer input reaches it.
- `openrouter-api.ts:59` final sub-branch — Phase 1.14 covered the substance; remainder is a combinatoric microbranch.
- `run-command.ts:49-50` SIGTERM-already-gone `catch` — race-dependent, flaky to test, defensive only.
- Various optional-chain micro-branches.

### Phase 2 — Callboard Adapter (~40h, callboard repo — deferred)

Lands separately, in callboard, whenever the integration becomes a priority. Not part of this work cycle.

| Step | What                                                                                                     | Est. |
| ---- | -------------------------------------------------------------------------------------------------------- | ---- |
| 2.1  | Extend `AgentProviderKind` to include `"openrouter"`.                                                    | 30m  |
| 2.2  | `OpenRouterAdapter.ts` — wraps `OpenRouterAgentRun`, translates events/options.                          | 6h   |
| 2.3  | `optionsAdapter.ts` — option mapping table from §4.                                                      | 3h   |
| 2.4  | `messageAdapter.ts` — event translation table from §3.                                                   | 4h   |
| 2.5  | `permissionAdapter.ts` — permission categories → canUseTool.                                             | 2h   |
| 2.6  | `toolAdapter.ts` — `buildToolServer` via re-wrap (§6 Option A).                                          | 6h   |
| 2.7  | `OpenRouterSessionProvider.ts` — `logs/` scanning + parsing.                                             | 6h   |
| 2.8  | Factory wiring + `AgentSettings` extension (`openRouterApiKey`, `openRouterBaseUrl`, `openRouterModel`). | 3h   |
| 2.9  | Frontend: provider selector in `ApiSettings.tsx`, chat-metadata routing, badge.                          | 6h   |
| 2.10 | Integration tests against a recorded OR response stream.                                                 | 4h   |

**Grand total:** Phase 0 + 1 = ~33h here, Phase 2 = ~40h in callboard. ~2 sprints across both repos.

---

## Key Risks

1. **MCP gap is structural, not paperable.** §6 Option A (re-wrap as plain OR tools) loses any future MCP-native features (HTTP/SSE transport, external tool servers). For callboard's current 4 in-process MCP servers, re-wrap is fine. If callboard later adds an HTTP-transport MCP tool server, this adapter can't consume it without OR adding MCP-client support. Flag and revisit.

2. **Zod version drift.** Callboard tool ports use `zod` (peer-installed). This repo pins `zod/v4`. If `@openrouter/agent` upgrades its internal Zod or callboard updates its peer dep, the `z.object(def.inputSchema)` conversion in §6 may break silently. Pin both sides; lock-step upgrade.

3. **Server-side tool gap on permissions.** `web_search` / `web_fetch` / `datetime` execute on OpenRouter's servers. `canUseTool` only sees client-side tools. Document; callboard users who need web-access policy on OR-served tools have to register them out (boolean) rather than gate (per-call).

4. **OR SDK maturity.** Per callboard's research doc (line 203 of `agent-abstraction-layer.md`): `@openrouter/agent` is ~3 weeks old (created 2026-04-01, v0.4.x), `@openrouter/sdk` is v0.12.x and still beta. Both warn of breaking changes. Pin exact versions; treat upgrades as adapter-update PRs in callboard, not casual bumps.

5. **No abort in agent core today.** Step 3 adds `AbortSignal` plumbing. The OR SDK's interrupt mechanism may itself be incomplete — verify it actually stops mid-turn rather than only between turns.

6. **No subagent spawning.** Callboard's chat sessions can spawn subagent sessions (callboard's own concept, not the SDK's). With this adapter, those subagent sessions also run on OR. That's fine in theory but doubles the cost-tracking burden; verify cost reporting aggregates correctly across nested sessions.

---

## Open Questions

- **Packaging.** This repo is library-only — but does callboard `npm install openrouter-agent-harness` from a registry, vendor the source into `backend/`, or git-submodule it? Cleanest is a real npm publish (private registry or public Apache-2.0 like the upstream OR SDK), but vendoring is faster for the first integration cycle. Decide before Step 12.
- **Compaction.** Callboard doesn't currently rely on `compaction_boundary` for anything load-bearing (it's emitted but consumers mostly pass it through to the UI). Confirm; if used for transcript archiving, we'll need a synthetic boundary signal from OR's `previousResponseId` rollover, which OR doesn't expose today.
- **Streaming input.** Callboard's `query()` accepts `prompt: string | AsyncIterable<unknown>` per the port. Today this repo only sends one user message per `runPrompt()`. If callboard ever passes an async-iterable, we need to drain it and concat or split into multiple turns. Defer until callboard actually exercises it (it doesn't today per the abstraction-layer audit).
- **`logsRoot` default.** `~/.openrouter-agent-harness/logs/` is the obvious choice (mirrors `~/.claude/projects/`, `~/.codex/sessions/`). Confirm; possibly `~/.config/openrouter-agent-harness/logs/` on XDG-compliant systems.

---

## Overlap With `claude-agent-sdk-parity.md`

The existing parity doc lists 26 missing features. The subset that callboard _needs_ (and this plan addresses) is a smaller list — most parity-doc P2 items (Skills, slash commands, plugins, NotebookEdit, ToolSearch, Monitor) are not callboard requirements. _(Skills / slash commands / plugins were reclassified in-scope for the library on 2026-05-24 — Cards 5.6 / 5.7 / 5.8, see Card 3.0. They remain non-callboard-requirements; the reclassification is about library coverage, not adapter scope.)_

| Parity-doc item                     | Required for callboard?                             | Covered here   |
| ----------------------------------- | --------------------------------------------------- | -------------- |
| Permission system (P0.1)            | **Yes**                                             | §5             |
| Context compaction (P0.2)           | No (callboard doesn't currently require it)         | Risk §Open Q 2 |
| Hooks PreToolUse/PostToolUse (P0.3) | **Yes**                                             | §8             |
| Glob tool (P0.4)                    | No (callboard provides its own via mcp-proxy tools) | —              |
| AskUserQuestion (P0.5)              | No (callboard handles via `permission_request`/UI)  | —              |
| CLAUDE.md context (P0.6)            | No (callboard injects via `systemPrompt`)           | §9             |
| Subagent system (P1.7)              | No (callboard has its own subagent concept)         | Risk §Risks 6  |
| Session forking (P1.8)              | Not yet                                             | —              |
| Streaming input (P1.9)              | Not yet                                             | §Open Q 3      |
| Rich message stream (P1.10)         | **Yes** (as AgentEvent)                             | §3             |
| MCP server support (P1.11)          | **Yes (worked around via re-wrap)**                 | §6             |
| Custom tools API (P1.12)            | **Yes (via ToolServerSpec)**                        | §6             |
| Effort/reasoning level (P1.13)      | No                                                  | §4 (dropped)   |
| File checkpointing (P1.14)          | No                                                  | —              |
| Session lifecycle hooks (P1.15)     | **Yes**                                             | §8             |

Net: callboard-compat work is a _subset_ of full parity work, with a different ordering. Permissions + hooks + custom-tools + event-stream are the load-bearing four.
