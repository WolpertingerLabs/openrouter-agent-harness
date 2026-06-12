# Comparative scenario authoring (Phase 6.5a)

This directory holds the canonical scenario set for the comparative-parity
harness. Each scenario is a JSON file that drives BOTH the Claude Agent SDK
and `@openrouter/agent` through the same logical flow against an emulated
backend, then asserts the two transcripts project to identical canonical
event streams.

The plan document is [`plans/comparative-parity-harness.md`](../../../../plans/comparative-parity-harness.md);
this README is the operational manual for the people writing scenarios.

## Files in this directory

- `01-single-turn-no-tool.json` — Bare-minimum happy path. Both SDKs return
  final text for "What is 2+2?".
- `02-single-tool-call.json` — One `echo` tool call + result. Foundational
  tool-loop parity.
- `03-multi-turn-tool.json` — Two `counter` calls + summary text. Verifies
  multi-turn message-history accumulation.
- `04-permission-denial.json` — `canUseTool` denies the `rm` tool; the
  model adapts in the next turn. Hook firing order asserted EXACTLY in the
  driver (this is the load-bearing parity claim).
- `_tools.ts` — Shared `echo` / `counter` / `rm` tool fixtures, wired for
  both SDKs (OR `tools` + Anthropic MCP server).
- `_helper.ts` — TS authoring API. `scriptEntry()` factory + canonical
  `promptHash` computation. Reusable from any one-off authoring script.

## What a scenario file looks like

```jsonc
{
  "name": "01-single-turn-no-tool",
  "description": "...",
  "prompt": "What is 2+2?",
  "model": "claude-sonnet-4-5-20250929",
  "systemPrompt": "You are a helpful math assistant. Answer concisely.",
  "tools": [],                   // names from `_tools.ts`
  "canUseToolPolicy": [...],     // optional per-tool allow/deny
  "script": [
    {
      "wire": "anthropic" | "openresponses" | "openai",
      "promptHash": "sha256:...",
      "turn": 0,
      "kind": "success",
      "response": { ... }        // wire-specific response payload
    }
    // ...
  ],
  "comparator": { "mode": "exact" }
}
```

**The script entries are dual-wire** (ambiguity call #2): a single JSON file
holds Anthropic-side responses AND OpenResponses-side responses for the
same scenario. The harness seeds each emulator's registry with only the
entries matching its wire.

`turn` indices are **per-promptHash**, not global. Each unique request body
hashes to its own track and starts at turn 0. Multi-turn scenarios where
the body grows monotonically (each turn includes the prior tool_result)
naturally produce distinct hashes per turn, so most entries use `"turn": 0`.

### The `anthropic` wire has TWO request streams

The Claude Agent SDK fires **two distinct request bodies per scenario**:

- A **session-title-generation** request (the SDK summarizes the session as
  a JSON `{"title": "..."}` for its own bookkeeping). This is internal SDK
  behavior — its response doesn't reach `query()`'s output stream.
- The **main agent-loop** request that drives the user's prompt.

Both must be scripted on the Anthropic wire or one of them will 500 the
emulator and the SDK will retry the loop. The title-gen entry's `response.content`
just needs to be a JSON title; the contents are never asserted against.

### Hashes are masked against wall-clock drift

The Claude CLI bakes "The current month is \<Month\> \<Year\>" into its
built-in `WebSearch` tool description, which is part of the hashed request
body. `canonicalizeRequest` masks that sentence (see `MASKED_CURRENT_MONTH`
in `../emulator/script-engine.ts`) so recorded hashes survive month
boundaries. Before the mask existed, every recorded Anthropic-wire hash
silently expired on 2026-06-01 and the whole emulated PR gate went red. If
hashes ever drift suite-wide again, suspect a NEW piece of clock- or
machine-derived text in the request body — diff a fresh
`DEBUG_COMPARATIVE_HASH=1` dump's `canonical` field against expectations
before reaching for re-recording.

## Authoring workflow (manual)

> The fully-automated live→script recorder is deferred to **6.10** (`if-needed`).
> Until then, the cycle is mechanical but manual. The
> [`scripts/capture-comparative-hashes.ts`](../../../../scripts/capture-comparative-hashes.ts)
> script automates the hash-capture step.

### Step 1 — draft the scenario JSON

Start with placeholder hashes for every entry:

```jsonc
{
  "name": "05-my-new-scenario",
  "prompt": "...",
  "tools": ["echo"],
  "script": [
    {
      "wire": "anthropic",
      "promptHash": "sha256:capture-me",
      "turn": 0,
      "kind": "success",
      "response": {
        /* title-gen JSON */
      },
    },
    {
      "wire": "anthropic",
      "promptHash": "sha256:capture-me",
      "turn": 0,
      "kind": "success",
      "response": {
        /* main turn 0 response */
      },
    },
    {
      "wire": "openresponses",
      "promptHash": "sha256:capture-me",
      "turn": 0,
      "kind": "success",
      "response": {
        /* OR turn 0 response */
      },
    },
  ],
  "comparator": { "mode": "exact" },
}
```

For each logical turn the SDK runs, add ONE entry per wire. Multi-turn
scenarios add one Anthropic entry + one OpenResponses entry per turn. The
title-gen request is Anthropic-only (the OR SDK doesn't fire that
internal call).

### Step 2 — run the capture probe

```bash
npx tsx scripts/capture-comparative-hashes.ts 05-my-new-scenario
```

The probe:

1. Spins up both emulators.
2. Patches each registry so any `sha256:capture-me` placeholder gets
   resolved by the FIRST script-miss of the matching wire — the captured
   hash gets assigned to the next pending entry in script order.
3. Drives both SDKs through the scenario; every captured hash is logged.
4. Writes the scenario JSON back with real hashes in place of the
   sentinels.

The probe is idempotent: re-running with already-resolved hashes is a no-op
("no capture-me sentinels — skipping").

### Step 3 — run the comparative suite

```bash
NODE_ENV=development npm run test:comparative
```

This runs every scenario through the harness + comparator, asserting
`result.pass === true`. On failure the test output includes the comparator's
Markdown report with side-by-side canonical event tables.

### Step 4 — commit

Commit `*.json` only. Don't commit any failure dumps under `tmp/`.

## What gets stripped from the canonical hash

The Anthropic SDK injects environment-specific content into every request
that has to be stripped before hashing or no two captures will agree:

- **Billing-header system blocks** (`x-anthropic-billing-header: cc_version=...;
cch=<content-hash>;`). The `cch` token rotates per SDK build.
- **SDK preamble** (`"You are a Claude agent, built on Anthropic's Claude
Agent SDK."`). Version-stable but irrelevant to parity.
- **`<system-reminder>` blocks** the SDK pastes from `~/.claude/CLAUDE.md`,
  project `CLAUDE.md`, skills, user-email and date context. Per-machine
  state that has no place in a scenario hash.
- **`metadata` field** (`user_id` carrying `device_id` / `account_uuid` /
  per-run `session_id` JSON).

Stripping happens in `canonicalizeRequest` in
[`emulator/script-engine.ts`](../emulator/script-engine.ts). If you add a
new piece of nondeterministic SDK injection that breaks hash stability,
extend the strip rules there.

The harness ALSO passes `settingSources: []` to `query()` to put the SDK
in isolation mode (no `.claude/settings.json` hierarchies). Skills /
CLAUDE.md content is still inserted by the underlying CLI; those get
filtered at the canonicalize layer instead.

## What's NOT here

- **Failure-injection scenarios** — 6.6 owns those. The `/responses` wire
  in 6.5a only ships the success-mode adapter; mid-stream errors, 429s,
  malformed JSON, and stream truncation are deferred until a scenario
  actually needs them.
- **Live mode** (`runScenario(path, 'live')`) — 6.7 wires `.env.local`
  and budget guards. The current harness throws on `'live'` so the gap is
  obvious.
- **A general scenario-recorder UI** — 6.10 is `if-needed`. The manual
  cycle documented above is the path until then.

## Useful one-liners

```bash
# Run only one scenario, in foreground, with stack on failure:
NODE_ENV=development npx vitest run \
  --config vitest.comparative.config.ts \
  -t "comparative scenario: 02-single-tool-call"

# Capture hashes for one scenario:
npx tsx scripts/capture-comparative-hashes.ts 02

# Dry-run (capture but don't write the JSON):
npx tsx scripts/capture-comparative-hashes.ts 02 --dry-run
```
