# Comparative parity harness

Two SDKs (`@anthropic-ai/claude-agent-sdk` and `@openrouter/agent`) driven
through the SAME logical flow, transcripts captured from each, comparator
asserts behavioral equivalence. Two modes:

- **Emulated** — both SDKs hit an in-process scripted emulator. Deterministic.
  No API keys. Runs on every PR as a merge gate.
- **Live** — both SDKs hit real provider endpoints. Nondeterministic. Cost
  money. Runs on non-draft non-fork PRs as a yellow smoke check.

Plan doc: [`plans/comparative-parity-harness.md`](../../../plans/comparative-parity-harness.md).
Scenario authoring guide: [`scenarios/README.md`](scenarios/README.md).

## Local invocation

```bash
# Emulated suite (default; what CI runs as the merge gate)
npm run test:comparative

# Live smoke subset (requires real API keys)
ANTHROPIC_API_KEY=sk-ant-... \
OPENROUTER_API_KEY=sk-or-... \
  npm run test:comparative:live

# Single scenario (emulated)
npx vitest run \
  --config vitest.comparative.config.ts \
  -t "comparative scenario: 02-single-tool-call"
```

If `ANTHROPIC_API_KEY` and/or `OPENROUTER_API_KEY` are absent, the live
runner skips cleanly with a single `it.skip` — it does NOT silently fall back
to emulated mode. Fork PRs in CI hit this skip path because GitHub strips
secrets from `pull_request` runs on forked branches.

## CI invocation

Two workflows, both triggered on `pull_request` against `main`:

| Workflow                                              | Required?           | Triggers on forks? | Triggers on drafts? |
| ----------------------------------------------------- | ------------------- | ------------------ | ------------------- |
| `.github/workflows/comparative-parity-emulated.yml`   | YES (merge blocker) | YES                | YES                 |
| `.github/workflows/comparative-parity-live-smoke.yml` | NO (yellow only)    | NO (skipped)       | NO (skipped)        |

**The emulated workflow is the parity gate.** It runs the full canonical-16
scenario set; failure blocks merge. No secrets required — same emulator runs
on first-party and fork PRs.

**The live workflow is informational.** It runs the 4-scenario `liveSmoke`
subset against real provider endpoints, gated on the PR being non-draft and
non-fork (forks can't access repo secrets). The job posts a PR comment with
cost breakdown and per-scenario status. A failure here surfaces as yellow,
NOT red — live runs are inherently flaky and a flaky merge gate is worse
than no gate. Phase 6.8 will add auto-issue-open on persistent regression.

## Budget guardrails

Two layers, both enforced in live mode only (the emulator never charges):

### Per-scenario cap (in the harness)

Every scenario gets a `maxCostUsd` ceiling. Default $0.50; per-scenario
override via the JSON `maxCostUsd` field. The harness's `BudgetMonitor`
watches the SUM of `costUsd` across both SDKs and aborts both runs the
moment the sum exceeds the cap. On breach the return carries
`costBreach: true` — but the test does NOT fail. Budget breach is a
"refresh the scenario" signal (the canon scenario shouldn't normally cost
more than $0.50 to run against either SDK; if it does, the prompt or the
script grew unexpectedly).

### Per-PR aggregate cap (in the workflow)

The live workflow tallies `totalCostUsd` from the JSONL artifact
`tmp/comparative-live-cost-report.jsonl` after the test step exits and
warns (does NOT fail) if the aggregate exceeds $0.25/PR. With 4 smoke
scenarios at ~$0.05 each, the cap is mostly defense-in-depth against a
hot-loop regression — if a single scenario starts costing $1, both the
per-scenario cap AND the aggregate cap will surface it.

### Budget gotchas

- **The `costUsd` field on `OpenRouterAgentRun` is cumulative, not
  per-event.** The harness feeds the budget monitor the DELTA between
  consecutive observations so back-to-back `turn_end`/`session_end`
  events don't double-count.
- **The Anthropic SDK only reports `total_cost_usd` on the final
  `result` message.** Until that arrives, the Anthropic side's cost is
  zero in the budget — a runaway scenario won't trip the cap until the
  SDK terminates. The harness's `harnessTimeoutMs` is the backstop.
- **Emulated runs always report `costUsd: 0`.** The budget knob is a
  no-op in emulated mode; the field exists on the transcripts but the
  monitor never trips.

## `@anthropic-ai/claude-agent-sdk` is pinned EXACTLY — do not add a caret

`package.json` pins `"@anthropic-ai/claude-agent-sdk": "0.3.150"` with **no
caret**. This is load-bearing, not tidiness.

The emulator matches a request by hashing its canonicalized body, and that
body includes the `tools` array — i.e. the bundled `claude` CLI's built-in
tool palette and every tool's full description text. Those descriptions are
part of the CLI build, so **any** version bump can change them, which changes
every recorded `promptHash` in `scenarios/*.json` at once.

When that happens the failure is maximally misleading:

1. Every Anthropic-side request script-misses → the emulator returns HTTP 500.
2. The agent SDK treats 500 as retryable and burns its 10-attempt
   exponential-backoff loop (~30s+).
3. The harness's 30s `timeoutMs` fires first and aborts the subprocess.
4. The test reports `Error: Claude Code process aborted by user` — which reads
   like a crash or a hang, with no hint that a hash mismatch caused it.

This is exactly what happened when a lockfile regeneration silently floated
the caret range `^0.3.150` to `0.3.179` (the palette gained `DesignSync` /
`Workflow`, dropped `Glob` / `Grep`, and renamed `Task` → `Agent`). The gate
went red on every PR for weeks and the whole suite ran 17 minutes instead of
2-3 because 20 scenarios each sat through the retry loop.

To intentionally move to a newer SDK, the fixtures must be **re-recorded
against that exact version** and the pin bumped in the same commit. Note that
`scripts/record-fixture.ts` only covers the OR side; the Anthropic-side
hashes need the manual capture workflow in
[`scenarios/README.md`](scenarios/README.md).

If you are debugging a suspicious `aborted by user` failure, set
`DEBUG_COMPARATIVE_HASH=1` — the script engine dumps the computed hash, the
canonical request body, and the registered catalog to
`tmp/comparative-hash-dump/` on each unique miss.

## Adding a new scenario

See [`scenarios/README.md`](scenarios/README.md) for the manual capture
workflow. The Phase 6.7-specific knobs you may want to set on the new
scenario JSON:

| Field              | Default | When to set                                                                                                                                                                               |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxCostUsd`       | `0.5`   | Multi-turn / long-context flows known to exceed $0.50 across both SDKs in live mode.                                                                                                      |
| `harnessTimeoutMs` | `30000` | Failure-injection scenarios where the SDK's retry loop pushes past 30s. DO NOT widen the global default — keep narrow per-scenario overrides.                                             |
| `liveSmoke`        | `false` | Only set on scenarios that cover a meaningfully-distinct slice of the parity surface; the smoke set is intentionally small (3–4 scenarios) and must fit under the $0.25/PR aggregate cap. |

## File layout

```
src/__tests__/comparative/
├── README.md                         (this file)
├── canonicalize.ts                   (transcript → canonical event projection)
├── comparator.ts                     (exact + tolerant comparator)
├── comparator.test.ts                (comparator unit tests)
├── env-leakage.comparative.test.ts   (verifies harness doesn't leak env)
├── harness.ts                        (runScenario; BudgetMonitor; emulated/live dispatch)
├── scenarios.comparative.test.ts     (emulated-mode describe.each driver)
├── scenarios.live.comparative.test.ts (live-mode liveSmoke driver — Phase 6.7)
├── scenarios.ts                      (Zod schema + loader)
├── transcript.ts                     (transcript types + masking)
├── emulator/                         (in-process Anthropic + OpenAI + OpenResponses wire emulator)
└── scenarios/                        (canonical scenario JSONs + authoring helper)
    ├── README.md                     (scenario authoring guide)
    ├── _helper.ts                    (scriptEntry factory + promptHash)
    ├── _tools.ts                     (shared tool fixtures, wired for both SDKs)
    └── NN-*.json                     (canonical scenarios 1–16)
```
