# Phase 7 — Context Compaction v2 (~33h, 5 cards)

> Successor to the Phase 5.1 compaction primitives (`src/compaction.ts` + the wiring in
> `src/agent.ts`). Produced from a 2026-06-11 review of the v1 design against four other
> harnesses, **all verified from primary sources** (not blog folklore): OpenAI Codex CLI
> (`codex-rs/core/src/compact.rs`, `session/turn.rs`, `protocol/src/openai_models.rs`),
> opencode (`packages/opencode/src/session/{compaction,overflow}.ts` on `dev`), Gemini CLI
> (`packages/core/src/context/chatCompressionService.ts`), and Claude Code (official docs +
> the `clawcodex` decompiled-TS reconstruction, cross-validated against docs).

## Why this exists

v1 (Phase 5.1) is a clean, tested skeleton: pure-function partition/threshold helpers, a
PreCompact hook, a transcript `compact` audit record, atomic fail-safe state writes, and
correct `previousResponseId` / in-flight-field clearing. What it gets wrong is _when_ it
triggers, _where_ it cuts, and _what happens when compaction itself fails_:

1. **Run-boundary-only trigger** (`agent.ts` — `iterate()`'s `finally`). A single long
   agentic run can overflow the context window before the check ever fires. Cron-style
   one-shot sessions get zero mid-run protection — and pay a summarizer call at run end
   even if the session never resumes. Every surveyed harness checks **before/between
   turns**: Codex pre-turn + mid-turn + on model switch; Gemini at the top of every
   `sendMessageStream`; opencode against every assistant message's real usage.
2. **chars/4 heuristic over `JSON.stringify(state.messages)`** while the drain loop already
   receives exact `usage.inputTokens` per response. Code/JSON runs ~3–3.5 chars/token, so
   v1 triggers late. Worse, `instructions` and tool schemas are **uncounted** — a callboard
   cron with a 108k-token instruction block + 63 tools consumes the entire nominal 20%
   headroom before the estimate counts a single message.
3. **Static `MODEL_CONTEXT_WINDOWS` table** with a 128k fallback — already drifting, wrong
   in both directions for unknown models. Codex deleted its static table entirely; model
   info (incl. window) is fetched from a `/models` endpoint. OR serves `context_length`
   on `/api/v1/models`.
4. **Message-count partition can produce invalid histories.** `partitionMessages` slices at
   message granularity; a keep tail starting with a `function_call_output` or an orphaned
   reasoning item hard-400s on the Responses API. Gemini advances its split index past
   model/function-response items; opencode's turns start at user messages, with a
   `splitTurn` fallback. v1 has no boundary snapping — this is a latent correctness bug,
   not a tuning issue.
5. **The summarizer can wedge the session permanently.** The summarize prefix (~80% of the
   window, plus JSON overhead, in an underestimating currency) goes to the _same model_ in
   one shot. Past-threshold states make the summarizer call itself overflow; it then fails
   on every subsequent run end with no retry, no trimming, no circuit breaker. Codex drops
   the oldest history item and retries until it fits; Claude Code parses the exact token
   gap from the API error and retries up to 3× — then stops with a "thrashing" error after
   3 consecutive auto-compact failures (their telemetry found 1,279 sessions with 50+
   consecutive failures wasting ~250k API calls/day before the breaker existed).
6. **Garbage into the summarizer.** Raw SDK JSON — including post-#213 encrypted reasoning
   blobs the summarizer cannot read but pays for.
7. **No cheap tier.** Tool outputs dominate agentic context. Claude Code clears old tool
   results first ("microcompaction") and only summarizes if still needed; opencode's prune
   erases tool outputs older than the last 2 turns / most recent 40k tokens; Gemini masks
   bulky tool outputs every turn; Anthropic's context-management API encodes the same
   clear-tool-results-first hierarchy. All of these are **zero-LLM-call** interventions.

### Field reference (verified values)

| Harness     | Trigger                                                                                          | Measurement                                                             | Keep verbatim                                                                                             | Failure handling                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex CLI   | 90% of window (`context_window*9/10`, min'd with server limit); pre-turn, mid-turn, model-switch | Server-observed `token_usage` from `ResponseEvent::Completed`           | User messages, newest-first, ≤20k tokens; summary appended as user msg                                    | On overflow during compaction: drop oldest item, retry; normal-sampling overflow marks usage=full → next pre-turn compacts                 |
| opencode    | usage ≥ input_limit − reserved (min(20k, maxOutput)); per assistant msg                          | Real usage tokens (incl. cache read/write)                              | Token-budgeted tail: 25% of usable, clamped 2k–8k, at turn boundaries (`splitTurn` for oversized turns)   | Prune tier first (protect last 2 turns + 40k); anchored incremental summary merges into `<previous-summary>`                               |
| Gemini CLI  | 50% of window, checked before every turn (`tryCompressChat`)                                     | countTokens API                                                         | Last 30% by char share, boundary advanced past model/functionResponse items                               | Re-counts after compress; restores original if inflated; failed-attempt flag stops retry loops; lighter `CONTENT_TRUNCATED` fallback       |
| Claude Code | `(window − min(maxOutput, 20k)) − 13k` ≈ 83.5% on 200k; 10k-token floor                          | `usage` from latest API response; API error text is the ultimate oracle | Recent tail (partial-compact variants); re-reads 5 recent files from disk post-compact (5k/file, 50k cap) | Drop-oldest retry ≤3 seeded from exact token gap; 3-strike thrashing circuit breaker; 5-layer cheap→expensive pipeline before any LLM call |

Common to all four: **structured summary schemas** (Claude Code's 9 numbered sections incl.
"All user messages" and verbatim-quoted next step; Gemini's `<state_snapshot>` XML;
opencode's anchored sections; Codex's bulleted handoff checklist), and **user messages are
sacred, tool output is expendable**.

## Cards

Each card is independently shippable. 7.1 and 7.2 are the highest-value; 7.3 should land
before `autoCompact` is relied on in production crons. Standard Phase 3+ workflow & gates
apply (fast-track merge, hard invariants, coverage ratchet — see
[`claude-sdk-parity-roadmap.md`](./claude-sdk-parity-roadmap.md#workflow--gates)).

| Card    | Title                                                              | Est.   | Depends on |
| ------- | ------------------------------------------------------------------ | ------ | ---------- |
| ~~7.1~~ | ~~Real-token trigger: mid-run check + dynamic context windows~~ ✅ | ~~8h~~ | —          |
| ~~7.2~~ | ~~Turn-boundary-safe partition + token-budgeted keep tail~~ ✅     | ~~5h~~ | —          |
| ~~7.3~~ | ~~Summarizer resilience: trim-retry, inflation check, breaker~~ ✅ | ~~6h~~ | 7.1 (soft) |
| ~~7.4~~ | ~~Tool-output prune tier (no-LLM microcompaction)~~ ✅             | ~~6h~~ | —          |
| 7.5     | Summary quality & ergonomics                                       | 8h     | —          |

### Card 7.1 — Real-token trigger: mid-run check + dynamic context windows (~8h)

Replace the char heuristic with real usage where available, and check **between turns
inside the drain loop**, not just at run end.

- After each `turn_end`, compare the response's reported input tokens (the loop already
  projects `usage.inputTokens` — see `toTranscriptUsage`) against a threshold of
  `contextWindow − outputReserve − safetyBuffer`. Adopt the absolute-buffer shape
  (Claude Code / opencode: ~20k output reserve) rather than the bare 0.8 ratio — the
  reserve is what guarantees the _summarizer call_ has room to respond.
- Mid-run compaction must cooperate with the SDK's in-memory `ConversationState` (the v1
  mid-iterate guard exists precisely because `compact()` races `state.save()`). Two
  acceptable shapes, decided at implementation time: (a) Codex-style mark-full → compact at
  the top of the next turn inside the same `iterate()`, or (b) pause-drain → compact →
  resume with rebuilt state. (a) is simpler and proven.
- Resolve context windows from OR `/api/v1/models` `context_length` (lazy fetch, in-memory
  TTL cache, `openrouter-api.ts` helpers) with precedence: explicit new
  `contextWindowTokens` option → live lookup → static table → 128k fallback. Codex
  precedent: the static table is a fallback, not the source of truth.
- Count `instructions` + serialized tool schemas in the fallback estimate when no real
  usage sample exists yet (first turn of a fresh session).
- Keep the run-end check (it is off the critical path and catches between-run drift), but
  skip the run-end summarizer call when the session is not expected to resume — gate on
  `persistSession` at minimum.
- `resolveCompactionThresholdChars` stays for back-compat; new token-denominated options
  documented alongside.

Acceptance: integration fixture where a multi-turn run crosses the threshold mid-run and
compacts without overflowing; unknown-model session resolves its window from the (mocked)
/models endpoint; explicit `compactionThreshold` still wins outright.

### Card 7.2 — Turn-boundary-safe partition + token-budgeted keep tail (~5h)

Fix the latent 400 and replace the messages-count keep window.

- `partitionMessages` v2: the keep tail must start at a **user message** (turn boundary).
  Walk the cut point backward until the boundary is clean; never split a
  `function_call`/`function_call_output` pair or strand a reasoning item from its
  following item. (Gemini: advance past `role === 'model'` / `isFunctionResponse`;
  opencode: turns start at user messages.)
- Keep budget in **tokens, not messages**: default ≈ min(8k, 25% of usable window),
  clamped (opencode's exact shape: 2k–8k), estimated with the existing char heuristic
  per message. `keepRecentTurns` remains honored as an override but is reinterpreted at
  true turn granularity; JSDoc updated.
- Oversized single turn (tool-heavy) that exceeds the budget alone: fall back to keeping
  the most recent complete tool-call group (opencode `splitTurn` analog), never an
  orphaned fragment.
- Property-style unit tests: for arbitrary interleavings of user/assistant/tool/reasoning
  items, the keep tail never starts with `function_call_output` or an unanchored
  reasoning item.

### Card 7.3 — Summarizer resilience: trim-retry, inflation check, breaker (~6h)

Make `compact()` unable to wedge a session.

- Cap summarize-call input: if the rendered prefix exceeds the summarizer's own budget
  (window − reserve), drop oldest items and retry (Codex `remove_first_item` loop;
  Claude Code seeds the retry from the exact overflow size when the API reports it).
- Inflation check (Gemini): if the post-compaction state is not meaningfully smaller than
  the pre-compaction state, restore the original and record a failed attempt.
- Circuit breaker: after N (default 3) consecutive **auto**-compaction failures on a
  session, stop auto-firing and surface a `Notification` hook + logger error (Claude
  Code's thrashing error). Manual `compact()` always allowed and resets the counter on
  success. Persist the counter in session state so cron re-invocations honor it.
- Strip encrypted reasoning content (`encrypted_content`) and image payloads from the
  summarize input — opaque to the summarizer, pure token waste (Claude Code strips
  images/docs to `[image]`/`[document]` markers pre-summarization).
- Render the prefix as a readable transcript (role-labelled text, truncated tool outputs)
  instead of `JSON.stringify` of raw SDK items.

Acceptance: fixture where the summarize call 400s with a too-long error → trim-retry
succeeds; fixture where it fails 3× → breaker opens, run continues un-compacted, hook
fires; encrypted-reasoning sessions produce summarizer input with zero `encrypted_content`
occurrences.

### Card 7.4 — Tool-output prune tier (no-LLM microcompaction) (~6h)

The cheapest intervention, run before full compaction is even considered.

- When the (7.1) threshold check approaches — or a configurable lower prune threshold —
  walk history newest→oldest, protect the most recent K turns (default 2) and the most
  recent ~40k tokens of tool output, then replace older `function_call_output` content
  in place with a marker. Two marker modes:
  - **Cleared**: `[Old tool result content cleared]` (Claude Code) for re-derivable tools
    (read_file, grep_files, glob, list_directory, run_command).
  - **Offloaded** (preferred when `persistSession`): write the original output under the
    session's `logsRoot` and replace with `[Tool result stored at: <path>]` — recoverable,
    the agent can re-read it (Claude Code's disk-offload layer; Manus "recoverable
    compression").
- Only commit the prune if it reclaims a minimum (opencode: >20k tokens), else skip — a
  no-op prune is pure cache invalidation. Note in the JSDoc: pruning rewrites the prefix
  and therefore costs one prompt-cache miss, same as compaction; it must not run every
  turn (contrast Gemini's per-turn masking, which their cache economics tolerate).
- Skip-list for protected tools (opencode protects `skill`); spawned-subagent results
  configurable.
- The message/tool-call _skeleton_ stays intact — the model still sees the calls happened.
- Emits its own transcript record (`kind: 'prune'`?) + Notification hook for observability.

### Card 7.5 — Summary quality & ergonomics (~8h)

- **Structured summary prompt** replacing the single-narrative `COMPACTION_PROMPT`:
  numbered sections — primary request & intent; key decisions & rationale; files, paths,
  identifiers (with snippets where load-bearing); errors & fixes incl. explicit user
  corrections; all user messages; pending tasks; current state; next step **with verbatim
  quotes** from the recent conversation (Claude Code's anti-drift device). Keep it a
  exported constant; v2 of the same contract.
- **Preserve recent user messages verbatim** in the rebuilt history, newest-first under a
  token cap (Codex: 20k), excluding prior summary messages by marker so repeat
  compactions don't nest.
- **`compactionModel` option**: summarize on a cheaper model (aider weak-model, opencode
  compaction-agent precedent). Default: the run's model.
- **`compact(reason, { instructions })`**: optional focus instructions appended to the
  summary prompt (Claude Code `/compact <focus>`); plumb from a new optional arg without
  breaking the existing signature.
- **Live `compaction` event** in `AgentCoreEvent` (post-compact, carrying reason, dropped
  count, pre/post estimated tokens) so consumers see it in-stream — today callboard only
  learns about compaction from the transcript on reload. Mirror to a `PostCompact` hook
  for symmetry with `PreCompact`. callboard projection of the live event lands separately
  in the callboard repo.

Acceptance: comparative fixture asserting summary message structure; nested-compaction
fixture (two compactions, no summary-of-summary in kept user messages); event-stream test
asserting the new event's shape and ordering relative to `stream_complete`.

## Non-goals (this phase)

- **Post-compact file re-injection** (Claude Code re-reads 5 recent files): valuable but
  needs read-tracking plumbing; revisit after 7.1–7.5 land.
- **Anchored incremental summaries** (opencode's `<previous-summary>` merge): the
  cleanest fix for summary drift, but a bigger contract change; candidate Phase 8 spike.
- **Server-side/remote compaction** (Codex `compact_remote`): no OR-side endpoint exists.
- **Cache-aware timing** (Claude Code's only-rewrite-when-cache-is-cold): interesting,
  low ROI at current session volumes.

## Companion docs

- [`claude-sdk-parity-roadmap.md`](./claude-sdk-parity-roadmap.md) — workflow & gates.
- `src/compaction.ts` / `src/compaction.test.ts` — v1 primitives this phase extends.
- Review transcript & verified field notes: forge workspace journal, 2026-06-11.
