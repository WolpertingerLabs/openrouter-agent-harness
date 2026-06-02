# Plan: Comparative Parity Harness (Phase 6)

> A follow-on phase to [`claude-sdk-parity-roadmap.md`](./claude-sdk-parity-roadmap.md). Replaces doc-claimed parity with **executable parity proofs**: run the same scenario through both the Claude Agent SDK and `openrouter-agent-harness`, and assert equivalent behavior. Two operating modes — a deterministic emulator for exact-match comparison (cheap, runs every PR) and a real-API mode for canary validation (paid, runs nightly/on-demand).

Status: **Carded 2026-05-24 — all 13 issues in Backlog.** Issues #120–#132 cover Cards 6.S1 / 6.1 / 6.2 / 6.3 / 6.4 / 6.5a / 6.5b / 6.5c / 6.6 / 6.7 / 6.8 / 6.9 / 6.10. Promote 6.S1 (#120) to Ready once Phase 5 build cards (5.2.5, 5.3, 5.5, 5.6, 5.7, 5.8) close — the parity surface needs to stop moving before scenarios get authored against it. Issue cross-references in card bodies use real GH numbers.

---

## Why this exists

The parity matrix in [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) is a documentation artifact. It says "Full parity on autonomous tool loop" because the surface APIs match — but it does not prove that an identical prompt + tool set + permission config drives both SDKs through the same sequence of tool calls, the same terminal status, the same token budget envelope, the same hook firing order.

The existing test infrastructure under `src/__tests__/integration/` is excellent at proving the library is **internally consistent** — `OpenRouterAgentRun` correctly consumes the `@openrouter/agent` SDK's event stream. But the mock there (`mock-openrouter.ts`) is a **module-level fake**: it replaces the SDK import wholesale. That means:

- It cannot catch transport-layer divergence (SSE chunk boundaries, retry behavior, content-type handling).
- It cannot be reused to validate the Claude Agent SDK in the same harness — the SDK shapes are different.
- A real-SDK regression in either library would not surface until production.

Phase 6 fills that gap. It introduces an **HTTP-level emulator** that speaks both wire formats, plus a **dual-mode harness** that points both SDKs at either the emulator (exact-match mode) or the live providers (canary mode). The same scenario script drives both runs; a comparator asserts behavioral equivalence.

This is the **only** test layer that exercises both code bases against the same input under controlled conditions. Without it, every parity claim in the matrix is theoretical.

---

## Scope

### In scope

- A standalone emulator process speaking the Anthropic Messages API + OpenRouter chat-completions API wire formats, sufficient to drive both SDKs through scripted multi-turn agent loops with tool use.
- A test harness that runs the same scenario through both SDKs in either emulated or live mode, with base-URL overrides plumbed end-to-end.
- A comparator with two modes: **exact** (event-stream equality, used in emulated mode) and **tolerant** (behavioral equivalence under nondeterminism, used in live mode).
- A small canonical scenario set (target: 8–12 scripts) covering happy paths, tool flows, error injection, cancellation, and permission denial.
- CI wiring: emulated mode on every PR (free, deterministic, fast); live mode nightly + manual trigger (paid, nondeterministic, slower).
- Drift-detection: a small subset of scenarios runs in **both modes** in nightly CI, with the live run as the canary that catches emulator drift from real provider semantics.

### Out of scope

- Replacing any existing test layer. Unit tests, the module-level mock in `mock-openrouter.ts`, and the recorded-fixture harness all remain. Phase 6 sits **above** them.
- Cross-provider model coverage in live mode beyond the minimum needed to validate the parity claim. Multi-provider testing is its own concern (and already partially covered by recorded fixtures).
- Mutation testing, fuzz testing, or property-based generation of scenarios. The canonical set is hand-curated and small by design.
- A general-purpose mock LLM server (Wiremock-for-LLMs). The emulator is scoped strictly to what the canonical scenarios require.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  scenario.json  (prompt + tools + script + comparator config)    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
   ┌─────────────────────┐         ┌─────────────────────────┐
   │ Claude Agent SDK    │         │ OpenRouter Agent Harness  │
   │ baseURL override →  │         │ baseUrl override →      │
   └──────────┬──────────┘         └────────────┬────────────┘
              │                                 │
              │  POST /v1/messages              │  POST /v1/chat/completions
              │  (Anthropic SSE)                │  (OpenAI-compatible SSE)
              │                                 │
              └─────────────────┬───────────────┘
                                │
                                ▼
              ┌──────────────────────────────────┐
              │  Emulator   (EMULATED MODE)      │
              │   - Dual wire format             │
              │   - Script-driven responses      │
              │   - Streaming + chunk control    │
              │   - Failure injection            │
              │                                  │
              │  OR  live providers (LIVE MODE)  │
              └──────────────┬───────────────────┘
                             │
                             │  (events captured from both runs)
                             ▼
              ┌──────────────────────────────────┐
              │  Comparator                      │
              │   - exact   (emulated mode)      │
              │   - tolerant (live mode)         │
              └──────────────┬───────────────────┘
                             │
                             ▼
                       pass / fail
```

### The emulator

A single Node process (vitest fixture or `pm2`-style standalone, depending on test ergonomics — TBD during 6.1) exposing two HTTP endpoints:

1. **`POST /v1/messages`** — Anthropic Messages API shape. Returns SSE stream of `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` events when `stream: true`. Supports `tool_use` content blocks for tool-calling.

2. **`POST /v1/chat/completions`** — OpenAI-compatible chat completions shape, which is what OpenRouter exposes and what `@openrouter/agent` consumes. SSE stream of `data: { choices: [{ delta: ... }] }` chunks ending with `data: [DONE]`. Supports `tool_calls` deltas for tool-calling.

Both endpoints share a single **script-execution engine** that maps an incoming request to a scripted response. Scripts are keyed on:

- **Prompt hash** — SHA-256 of the canonicalized request (messages + tools + system prompt + model). Canonicalization strips request IDs, timestamps, and any other non-semantic fields.
- **Turn index** — a counter incremented per request from the same scenario session (since a multi-turn agent loop fires multiple requests against the same emulator endpoint).

A script entry specifies:

- The response payload (text, tool calls, stop reason).
- The streaming behavior (chunk boundaries, inter-chunk delay).
- Optional failure injection (HTTP error mid-stream, malformed JSON, connection drop, 429 with `Retry-After`).
- Optional turn metadata (input/output token counts, model identifier).

**A missing fixture is a hard failure**, not a fallback. This is the single most important property: a script that doesn't match the incoming prompt-hash + turn-index causes the test to fail loudly with a diagnostic dump of what the SDK actually sent. Silent fallthrough is what makes mock-based tests rot.

### Scenario file format (preliminary)

```json
{
  "name": "single-tool-call-echo",
  "model": "anthropic/claude-sonnet-4-5",
  "tools": ["echo"],
  "prompt": "Echo 'hello world' using the echo tool.",
  "instructions": null,
  "script": [
    {
      "turn": 0,
      "match": { "promptHash": "sha256:abc123..." },
      "response": {
        "wire": "anthropic",
        "stopReason": "tool_use",
        "content": [
          { "type": "text", "text": "I'll echo that." },
          {
            "type": "tool_use",
            "id": "toolu_01",
            "name": "echo",
            "input": { "text": "hello world" }
          }
        ],
        "usage": { "input_tokens": 42, "output_tokens": 18 }
      },
      "stream": { "chunkSize": "natural", "interChunkDelayMs": 0 }
    },
    {
      "turn": 1,
      "match": { "promptHash": "sha256:def456..." },
      "response": {
        "wire": "anthropic",
        "stopReason": "end_turn",
        "content": [{ "type": "text", "text": "Done." }],
        "usage": { "input_tokens": 78, "output_tokens": 4 }
      }
    }
  ],
  "comparator": {
    "mode": "exact",
    "ignore": ["timestamps", "request_ids"]
  }
}
```

For OpenAI-shaped scripts (`wire: "openai"`), the response payload follows the chat-completions shape. The harness picks which wire format to serve based on the request's URL path — the script can declare which it expects, but the emulator infers from the request.

Critically, **most scenarios will have parallel script entries for both wire formats** — one Anthropic-shaped response for the Claude Agent SDK, one OpenAI-shaped response for `@openrouter/agent` — describing semantically the same model output. The comparator then asserts the **downstream behavior** (tool calls dispatched, hooks fired, events emitted on the host stream) is equivalent regardless of wire format.

### The dual-mode harness

A vitest suite (`src/__tests__/comparative/`) that, for each scenario:

1. **Spins up** the emulator (or in live mode, skips this step and uses real API keys from `.env.local`).
2. **Configures both SDKs** with the appropriate base URL override + the scenario's tool registry + the scenario's prompt.
3. **Runs both SDKs concurrently**, capturing every event from each into a recorded transcript.
4. **Invokes the comparator** with both transcripts and the scenario's comparator config.
5. **Reports** pass/fail with a structured diff if mismatched.

Both runs use **independent emulator script cursors** (so neither SDK's behavior pollutes the other's). When running against the live API, both SDKs hit real endpoints — slower, costs money, but proves the emulator hasn't drifted.

### Base-URL override mechanics

Both SDKs already support this, but **asymmetrically**:

- **`@openrouter/agent`** — the openrouter-agent-harness library plumbs `baseUrl` through to the OR client constructor's `serverURL` parameter (`src/agent.ts:398`). Already tested at `src/agent.test.ts:325`. Passed via **ctor config**.
- **`@anthropic-ai/claude-agent-sdk`** — respects `ANTHROPIC_BASE_URL`; the agent SDK forwards env config to its underlying Anthropic client. Passed via **env injection per test process**. (6.S1 confirms the agent-SDK wrapper doesn't swallow it and pins the agent-SDK version that exhibits this behavior.)

Document the asymmetry but don't try to unify it — the wire formats differ anyway, so a shared abstraction would leak.

**Resolved hosting pattern** (per [`spikes/6.S1-baseurl-emulator-hosting.md`](./spikes/6.S1-baseurl-emulator-hosting.md), 2026-05-25): **in-process emulator + per-`query()` `Options.env` injection** on the Anthropic side. The agent SDK spawns a `claude` subprocess per call and reads `ANTHROPIC_BASE_URL` _in that subprocess_, not in the parent — so env-isolation is structural. The harness passes `{ ...process.env, ANTHROPIC_BASE_URL: '<emulator-url>', ANTHROPIC_API_KEY: 'sk-ant-emulator-stub' }` via `query({ options: { env: ... } })` per scenario. No parent-process `process.env` mutation; no vitest setup-file env injection; no subprocess emulator. Rejected alternatives (subprocess emulator, vitest project-level env) and tradeoffs are documented in the spike.

The emulator binds to a random ephemeral port per test process (parallel safety), and the harness writes the bound URL into both SDK configs (OR via ctor `baseUrl`, Anthropic via `Options.env.ANTHROPIC_BASE_URL`) before kicking off the run.

### The comparator

Two modes, both producing structured pass/fail reports:

**Exact mode (emulated runs):**

- Event-stream equality after canonicalization. Both transcripts are reduced to a normalized event sequence (type + payload, with timestamps / request IDs / message IDs masked).
- Tool calls compared by `{ name, args }`. Tool execution order matters.
- Terminal status (`turn.end` reason, total turn count) compared exactly.
- Token counts compared exactly (the emulator scripted them).
- Any divergence is a test failure with a side-by-side diff.

**Tolerant mode (live runs):**

- Tool-call **sequence** compared by `{ name, args }`. Args compared with structural-equality where deterministic, or with declared per-arg tolerances where the scenario flags them as "model-creative."
- Terminal status compared exactly.
- Token counts compared with a percentage band (default ±15%, per-scenario override).
- Final assistant text not compared exactly — instead asserted to satisfy a per-scenario predicate (length range, substring match, regex, or a simple LLM-judge call against a rubric — last resort).
- Tool execution order compared exactly.
- Hook firing order compared exactly.

**The hooks/event-shape assertions are exact in both modes.** That's the load-bearing parity claim — the model can phrase its response however, but the host's view of what the SDK did must be identical.

### Failure-injection capabilities

Beyond deterministic happy-path testing, the emulator can script failure conditions that are difficult or impossible to elicit reliably from a real provider:

- **Mid-stream HTTP 5xx** — connection accepted, partial SSE delivered, then `connection: close` with no terminal event.
- **429 with `Retry-After`** — exercises the SDK's retry/backoff logic.
- **Malformed SSE chunk** — JSON parse error in the middle of a `content_block_delta`. SDKs must surface a typed error rather than crash.
- **Truncated stream** — TCP close mid-event. Tests the SDK's "stream ended unexpectedly" path.
- **Stop reason variants** — `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn` (Anthropic-specific). Each routes through different SDK terminal code paths.
- **Tool call with malformed args** — the model returns invalid JSON in `tool_use.input`. The SDK's argument-parsing fallback should kick in.
- **Cache hit/miss markers** — Anthropic-side prompt-cache reporting. Validates token accounting under cache-hit conditions.
- **SSE chunk boundary splits a JSON field** — `{"text": "hel` in one chunk, `lo"}` in the next. Exercises the SDK's incremental JSON parser.

Each failure scenario is its own script, and lives in the canonical set alongside the happy-path scenarios.

---

## The canonical scenario set

Initial target: 8–12 scripts. The full set won't be defined until 6.5, but the intended coverage:

| #   | Scenario                          | Purpose                                                  |
| --- | --------------------------------- | -------------------------------------------------------- |
| 1   | Single-turn no-tool               | Bare-minimum happy path. Both SDKs return final text.    |
| 2   | Single tool call + result         | Foundational tool-loop parity.                           |
| 3   | Multi-turn (2+) with tool         | Multi-turn state, message accumulation, history flow.    |
| 4   | Permission denial (`canUseTool`)  | Phase 3.1/3.2 parity — host short-circuits a tool.       |
| 5   | Plan-mode read-only filter        | Phase 3.3 parity — write tools blocked, reads allowed.   |
| 6   | Mid-stream cancellation           | `signal.abort()` mid-turn. Cleanup semantics.            |
| 7   | Tool error mid-loop               | Tool throws; SDK feeds error back to model; loop resumes |
| 8   | Hook block-and-modify (post-3.7)  | PreToolUse short-circuits a tool call.                   |
| 9   | Stop-reason: max_tokens           | Token-cap terminal path.                                 |
| 10  | Stop-reason: stop_sequence        | Custom stop-sequence terminal path.                      |
| 11  | Malformed tool-call args recovery | Model emits invalid JSON; SDK recovers.                  |
| 12  | Retry on 429                      | Rate-limit backoff parity.                               |

**Scenarios gated on later phases** (subagents, MCP, compaction, streaming input, etc.) get added as those phases land — each new feature ships with a scenario in this harness as part of its acceptance criteria.

---

## CI wiring

**Emulated mode runs on every PR.** Deterministic, free, fast (target: full suite under 30s). Failure is a merge blocker. This is the primary parity gate.

**Live mode runs nightly** via a scheduled workflow + on-demand via `workflow_dispatch`. Uses repo-secret API keys. Failure opens an issue tagged `parity-drift`; doesn't block merges directly. The nightly run also re-runs the emulated suite against the same scenarios — if emulated passes but live fails, the emulator has drifted from provider semantics, and the failing scenario's script needs refreshing.

**A small subset (3–4 scenarios) runs in live mode on every PR** as a smoke test, gated on `if: github.event.pull_request.draft == false` and skipped if no API key is configured (so forks don't break). Budget cap: ~$0.05/PR.

**Budget guardrails:**

- Live-mode runs declare a `maxCostUsd` per scenario (default **$0.50**, per-scenario override for known-pricier flows).
- PR smoke subset budget cap: **~$0.25/PR** across its 3–4 scenarios.
- The harness aborts a run that exceeds the budget and reports it as a flaky-scenario warning, not a hard fail.
- Nightly aggregate spend tracked in the workflow output for review.

---

## Implementation phasing within Phase 6

| Card | Title                                                              | Est.   | Depends on          |
| ---- | ------------------------------------------------------------------ | ------ | ------------------- |
| 6.S1 | SPIKE — verify env-var baseURL + pick emulator hosting pattern     | 1–2h   | —                   |
| 6.1  | Emulator skeleton + Anthropic Messages wire format                 | 10–12h | 6.S1                |
| 6.2  | Emulator: OpenAI/OR chat-completions wire format                   | 8–10h  | 6.1                 |
| 6.3  | Dual-mode harness scaffolding + base-URL plumbing                  | 5–7h   | 6.1, 6.2            |
| 6.4  | Comparator: exact + tolerant modes                                 | 8–10h  | 6.3                 |
| 6.5a | Scenario authoring helper + happy-path scenarios (#1–#4)           | 6–8h   | 6.4                 |
| 6.5b | Scenarios #5–#8 (plan-mode, cancel, tool error, hook block)        | 5–7h   | 6.5a                |
| 6.5c | Scenarios #9–#12 (stop-reason variants, malformed args, 429 retry) | 5–7h   | 6.5a                |
| 6.6  | Failure-injection scenarios                                        | 6–8h   | 6.5a                |
| 6.7  | CI wiring + budget guardrails                                      | 4–5h   | 6.5a                |
| 6.8  | Drift-detection workflow + nightly run                             | 3–4h   | 6.7                 |
| 6.9  | Scenario-additions rolling card (Phase 3/4/5 backfill + ongoing)   | n/a    | 6.8, prior phases   |
| 6.10 | _(Deferred, if-needed)_ Live→script recorder                       | 6–8h   | 6.5a if 6.5 painful |

**Phase 6 total:** ~61–83h, ~1.5–2 weeks full-time (revised from original ~80h after spike de-risking, 6.5 split, and 6.S1 trimming 6.3 by ~1h).

**Phasing dependency:** Phase 6 is gated on **Phase 5 substantially complete** — Phases 3 and 4 are both 100% done, but Phase 5 still has the surface that scenarios would assert against (MCP bridge, streaming input, skills, slash commands, plugins). Starting earlier risks scenarios that have to be rewritten as the surface settles. Card the Phase 6 issues only after Phase 5's build cards close.

**Order of operations within the phase:**

1. **6.S1** runs first — small spike to pin the agent-SDK version and pick the emulator-hosting pattern that 6.1/6.3 inherit. (Could fold into 6.1 as task 0; kept standalone to match the Phase 5 spike pattern and keep the answer findable in project history.) **Resolved 2026-05-25**: agent-SDK pinned to `^0.3.150`; in-process emulator + per-call `Options.env` injection. See [`spikes/6.S1-baseurl-emulator-hosting.md`](./spikes/6.S1-baseurl-emulator-hosting.md).
2. **6.1 → 6.2** sequential (the wire formats share infrastructure but the second pass tells you what to refactor in the first).
3. **6.3 → 6.4** sequential (the comparator can't be specified until the harness produces transcripts).
4. **6.5a** lands first scenario + authoring helper. **6.5b**, **6.5c**, and **6.6** are parallel-eligible once 6.5a sets the authoring pattern — each is a self-contained set of fixture files with no shared production touches. Under a one-card-in-flight rule they run serial; under parallel-pull they're independent.
5. **6.7 → 6.8** sequential (CI wiring then drift detection).
6. **6.9** is a rolling card — every new card in Phase 3/4/5/later post-6.5 should add a scenario in the same PR. The PR template gains a "Scenario added" checkbox alongside the existing CHANGELOG checkbox.
7. **6.10** stays in Backlog tagged `if-needed`; only pulled if 6.5 turns out painful to author by hand.

---

## Risks and mitigations

| Risk                                                                                      | Mitigation                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Emulator drifts from real provider semantics.** Tests pass but production breaks.       | Live-mode nightly runs are the canary. Drift detected within 24h. Subset of scenarios runs in live mode on every PR as additional defense.                                                                |
| **Maintenance burden grows.** Every SDK bump requires emulator updates.                   | Keep the emulator's surface area strictly bounded by canonical scenarios. Resist the urge to model behaviors no scenario depends on. Drift caught by canary, not by speculative coverage.                 |
| **Live-mode flakiness undermines confidence.**                                            | Tolerant comparator with declared per-scenario tolerances. One automatic retry on a single scenario. Flake threshold (>10% failure rate over 7 days) auto-opens an issue tagged `scenario-needs-refresh`. |
| **Scenarios become stale as Phases 3/4/5 land.** Old scripts encode obsolete behavior.    | 6.9 is a rolling card. PR template for any Phase 3/4/5 work post-6.5 includes a "scenario update" checkbox.                                                                                               |
| **Cost overrun in live mode.** A misconfigured retry loop racks up spend.                 | Per-scenario `maxCostUsd` cap; aggregate nightly spend reported. PRs opening new live-mode scenarios require Ben's approval (label gate).                                                                 |
| **Claude Agent SDK doesn't expose `baseURL` cleanly.** Plumbing the override is invasive. | Fall back to `ANTHROPIC_BASE_URL` env injection per-test-process. Spike during 6.3; if neither approach works, file an issue with Anthropic and proceed with whichever workaround is least gross.         |
| **Two wire formats double the emulator's complexity.**                                    | Share the script-execution engine; only the request-parsing and response-serialization layers differ. Target: <500 LOC per wire-format adapter.                                                           |
| **Comparator's tolerant mode lets real bugs slip through.**                               | Hook firing order + event-shape assertions stay exact in both modes. Only model-creative outputs (text, token counts) get tolerance bands. Any tolerance widening requires a PR-comment justification.    |
| **Test parallelism breaks emulator state.**                                               | Each test process binds its own ephemeral port and owns its own emulator instance. Scenarios never share state. If parallelism becomes a hot path, the emulator becomes a per-test in-process import.     |

---

## Open questions

### Resolved

- **Q5 — Does the Claude Agent SDK accept a pre-built `Anthropic` client / how do we override the base URL?** **Resolved:** `@anthropic-ai/claude-agent-sdk` respects the `ANTHROPIC_BASE_URL` environment variable (the agent SDK forwards env config to its underlying Anthropic client). 6.3 plumbs via env injection per test process. 6.S1 verifies the agent-SDK wrapper doesn't swallow it and pins the version.
- **Q1 — In-process vs subprocess emulator?** **Resolved** by [`spikes/6.S1-baseurl-emulator-hosting.md`](./spikes/6.S1-baseurl-emulator-hosting.md) (2026-05-25): **in-process emulator + per-`query()` `Options.env` injection**. The agent SDK already spawns a subprocess per call and reads `ANTHROPIC_BASE_URL` inside that subprocess, so env-isolation is structural — no second layer of subprocessing needed. Original recommendation (start in-process) stands.

### Still open (carded or deferred)

2. **Script storage format — JSON vs TypeScript?** JSON wins on portability and recordability; TS wins on type safety and IDE support. Recommendation: JSON for the canonical set (matches existing `src/__tests__/integration/fixtures/`), with a TS helper for authoring. Folded into 6.5a.
3. **Should the emulator support recording from live runs?** I.e., point it at the real provider, capture the request/response, write a script. Mirrors the existing `scripts/record-fixture.ts` pattern. Carded as **6.10** in Backlog with `if-needed` label; pulled only if 6.5 turns out painful to author by hand.
4. **LLM-judge as last-resort comparator for final-text?** Adds a third LLM call per live-mode scenario; meaningful spend. Recommendation: avoid by default; only allow when a scenario can prove no predicate-based assertion is feasible. Re-evaluate during 6.5b/c if a scenario actually can't be asserted with predicates.
5. **Where does this live in the codebase?** Proposed: `src/__tests__/comparative/` for the harness + scenarios, `src/__tests__/comparative/emulator/` for the emulator. Keeps it adjacent to the existing integration tests, separate enough that the build doesn't pull it in. Locked in at 6.1.

---

## How this relates to existing test layers

| Layer                                          | What it proves                                     | Why it stays                                                             |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit tests (`src/*.test.ts`)                   | Individual functions behave correctly.             | Fastest signal; covers edge cases the integration layer can't isolate.   |
| Module-mock integration (`mock-openrouter.ts`) | The library correctly consumes SDK events.         | Catches library-internal regressions cheaply. Doesn't need real network. |
| Recorded fixtures                              | The library handles real-SDK output shapes.        | Real-provider sanity. Cross-provider proof. No comparison axis.          |
| **Comparative parity harness (new)**           | **Both SDKs do the same thing on the same input.** | **The only layer that proves parity. Nothing else does.**                |

The comparative harness does not replace any of these — it adds a parity axis the others lack.

---

## Success criteria

Phase 6 is **Done** when:

1. The emulator serves both Anthropic and OpenAI wire formats with deterministic script-driven responses, including the full failure-injection set.
2. The dual-mode harness can run a scenario through both SDKs in either mode, with base-URL overrides plumbed end-to-end.
3. The canonical scenario set has ≥10 scenarios passing in emulated mode, ≥6 passing in live mode.
4. Every PR runs the emulated suite as a merge gate.
5. Nightly CI runs the full live suite and reports drift on failure.
6. A scenario-addition card is present in every subsequent Phase 3/4/5 PR template for user-facing features.

**Stretch:** The harness becomes the spec for parity itself — the parity matrix in `claude-agent-sdk-parity.md` updates its "Full" rows to require a corresponding scenario, not just a doc claim.

---

## Companion docs

- [`claude-agent-sdk-parity.md`](./claude-agent-sdk-parity.md) — the parity matrix this harness validates.
- [`claude-sdk-parity-roadmap.md`](./claude-sdk-parity-roadmap.md) — Phase 3 / 4 / 5 plan that Phase 6 follows.
- [`callboard-compatibility.md`](./callboard-compatibility.md) — Phase 0 / 1 / 2 plan, fast-track gates, hard invariants.
- `src/__tests__/integration/README.md` — the existing module-mock + recorded-fixture layer this harness sits above.
