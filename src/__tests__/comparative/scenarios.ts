// Scenario file loader + schema for the comparative-parity harness.
//
// v1 is intentionally minimal: a scenario is a name + prompt + an array of
// script entries that match the existing emulator ScriptEntry shape. The
// loader copies entries into BOTH adapters' registries (Anthropic + OpenAI),
// and the emulator's wire dispatch (router in `emulator/index.ts`) decides
// which wire each entry serves on the wire.
//
// 6.5a will expand this schema with comparator config, per-scenario
// tolerances, failure-injection metadata, and the cost-budget knob for live
// mode. This file is scoped strictly to what the 6.3 smoke needs to compile.
//
// TODO(6.5): expand schema — comparator config, tolerances, budgets.

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { ScriptEntry } from './emulator/index.js';

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);

const anthropicResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn']),
  stopSequence: z.string().nullable().optional(),
  content: z.array(anthropicContentBlockSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const openaiResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']),
  content: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  reasoning: z.string().optional(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

// ----- /responses (OpenResponses) wire — Phase 6.5a -----
//
// Mirrors the in-memory `OpenResponsesResponse` shape from `script-engine.ts`.
// Tool-use args land as a JSON string so the wire-level "args streamed as
// incremental string concat" property is preserved verbatim from script to
// emulator output.

const openResponsesContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
]);

const openResponsesResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  status: z.enum(['completed', 'incomplete', 'failed']),
  content: z.array(openResponsesContentBlockSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative().optional(),
  }),
});

const streamControlSchema = z
  .object({
    chunkSize: z.union([z.literal('natural'), z.number().int().positive()]).optional(),
    interChunkDelayMs: z.number().int().nonnegative().optional(),
  })
  .optional();

const anthropicSuccessEntrySchema = z.object({
  wire: z.literal('anthropic').optional(),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: anthropicResponseSchema,
  stream: streamControlSchema,
});

// Phase 6.5c: scenario #12 needs to script a 429 on the Anthropic wire so the
// SDK exercises its built-in backoff. The adapter already supports the failure
// mode; this is the schema half (carries kind=failure, retry-after, no
// response payload).
// Phase 6.6: extends the surface to cover the four wire-level failure modes
// scenarios #13–#16 exercise (mid_stream_error, malformed_delta,
// truncated_stream, split_json_field). The shapes mirror the engine-level
// `AnthropicFailureMode` discriminated union 1:1. The `partial` field carries
// the response whose initial events are replayed up to the failure point —
// optional because some modes (429) don't need it.
const anthropicFailureModeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rate_limit_429'),
    retryAfter: z.union([z.string(), z.number()]),
  }),
  z.object({
    type: z.literal('mid_stream_error'),
    eventsBeforeError: z.number().int().nonnegative(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    type: z.literal('malformed_delta'),
    atDeltaIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('truncated_stream'),
    eventsBeforeTruncation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('split_json_field'),
    atDeltaIndex: z.number().int().nonnegative(),
    splitAt: z.number().int().nonnegative(),
  }),
]);

const anthropicFailureEntrySchema = z.object({
  wire: z.literal('anthropic').optional(),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('failure'),
  failure: anthropicFailureModeSchema,
  // Partial response whose initial events are replayed up to the failure
  // point. 429 doesn't use this; the other four modes typically do.
  partial: anthropicResponseSchema.optional(),
  stream: streamControlSchema,
});

const anthropicEntrySchema = z.union([anthropicSuccessEntrySchema, anthropicFailureEntrySchema]);

const openaiEntrySchema = z.object({
  wire: z.literal('openai'),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: openaiResponseSchema,
  stream: streamControlSchema,
});

// Phase 6.5c: failure-mode subset on the OpenResponses wire. v1 shipped only
// `rate_limit_429` for scenario #12.
// Phase 6.6: extended to cover the wire-level failure modes scenarios #13–#16
// exercise on the OR side. Shapes mirror the engine-level
// `OpenResponsesFailureMode` discriminated union 1:1. Naming differs from the
// Anthropic side intentionally (`atEventIndex` vs `atDeltaIndex`,
// `malformed_event` vs `malformed_delta`) because the OR /responses wire's
// event vocabulary uses "event" / "output_text.delta" / "function_call_-
// arguments.delta", not Anthropic's "content_block_delta" — keeping the
// per-wire term keeps scenario JSONs readable.
const openResponsesFailureModeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rate_limit_429'),
    retryAfter: z.union([z.string(), z.number()]),
  }),
  z.object({
    type: z.literal('mid_stream_error'),
    eventsBeforeError: z.number().int().nonnegative(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    type: z.literal('malformed_event'),
    atEventIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('truncated_stream'),
    eventsBeforeTruncation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('split_json_field'),
    atEventIndex: z.number().int().nonnegative(),
    splitAt: z.number().int().nonnegative(),
  }),
]);

const openResponsesSuccessEntrySchema = z.object({
  wire: z.literal('openresponses'),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('success'),
  response: openResponsesResponseSchema,
  stream: streamControlSchema,
});

const openResponsesFailureEntrySchema = z.object({
  wire: z.literal('openresponses'),
  promptHash: z.string(),
  turn: z.number().int().nonnegative(),
  kind: z.literal('failure'),
  failure: openResponsesFailureModeSchema,
  // Partial response whose initial events are replayed up to the failure
  // point. 429 doesn't use this; the other four modes typically do.
  partial: openResponsesResponseSchema.optional(),
  stream: streamControlSchema,
});

const openResponsesEntrySchema = z.union([
  openResponsesSuccessEntrySchema,
  openResponsesFailureEntrySchema,
]);

const scriptEntrySchema = z.union([
  anthropicEntrySchema,
  openaiEntrySchema,
  openResponsesEntrySchema,
]);

// ----- Comparator config (Phase 6.4) -----
//
// Carried on the scenario; consumed by `comparator.ts`. `mode` picks
// exact (deterministic emulator runs) vs tolerant (live runs). Token /
// final-text / per-arg tolerance bands apply ONLY in tolerant mode — the
// load-bearing parity claim ("event-shape + hook firing order exact in both
// modes") cannot be widened from here. See `plans/comparative-parity-harness.md`
// § "The comparator" for rationale.
//
// `ignore` extends the hard-coded mask set in `transcript.ts` with scenario-
// local additions; it does NOT subtract from the base set. Keys are matched
// the same way `maskNondeterminism` matches its built-in set — by exact key
// name anywhere in the projected event tree.
//
// `argTolerances` is keyed by `<toolName>.<dot.path.into.args>` — dot-path
// syntax, no JSONPath, no array indexing. v1 keeps this simple; richer
// matching is a follow-up if a real scenario needs it.

const finalTextAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('substring'), value: z.string() }),
  z.object({ type: z.literal('regex'), value: z.string() }),
  z.object({
    type: z.literal('lengthRange'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
]);

const argToleranceSchema = z.discriminatedUnion('type', [
  // Substring containment on a string-valued arg.
  z.object({ type: z.literal('substring'), value: z.string() }),
  // Numeric proximity within ±delta on a number-valued arg.
  z.object({ type: z.literal('numericDelta'), delta: z.number().nonnegative() }),
  // "Any value, just must be present" — for fields the model varies freely.
  z.object({ type: z.literal('anyString') }),
]);

const comparatorConfigSchema = z
  .object({
    mode: z.enum(['exact', 'tolerant']),
    ignore: z.array(z.string()).optional(),
    tokenTolerancePct: z.number().nonnegative().optional(),
    finalTextAssertion: finalTextAssertionSchema.nullable().optional(),
    argTolerances: z.record(z.string(), argToleranceSchema).nullable().optional(),
    // Phase 6.5b: cancellation scenarios populate `thrown` on both
    // transcripts (the SDKs throw an AbortError on signal.abort()). When
    // `ignoreThrown` is true, the comparator skips the per-side `thrown`
    // failure path so the parity claim on the canonical events that DID
    // arrive can still pass. Used by scenario #6; never widen this to
    // happy-path scenarios — a silent throw on a non-cancelled scenario
    // is exactly the kind of rot this harness exists to catch.
    ignoreThrown: z.boolean().optional(),
    // Phase 6.5b: aborted runs end on the SDK's local "aborted" terminal,
    // which differs by SDK (Anthropic `result.subtype = 'error'`; OR's
    // `stream_complete` may not fire at all, so the projection's
    // `terminalStatus` is null). When this is set, the comparator skips
    // the terminal-status equality check. Token usage is similarly skipped
    // because aborted runs have no usage to report.
    skipTerminalCheck: z.boolean().optional(),
    // Phase 6.5b: when true, the comparator skips event-stream positional
    // comparison entirely and only asserts hookOrder + terminal/thrown
    // policy. The cancellation scenario uses this because the two SDKs'
    // text-delta granularity differs (Anthropic emits one assistant
    // message with all text; OR emits per-chunk text_deltas), so positional
    // text comparison can never match for streaming mid-cancel even with
    // identical wire payloads.
    skipEventStreamCheck: z.boolean().optional(),
    // Phase 6.6: when true, the test driver's "if thrown, must look
    // abort-flavored" defensive regex check is SKIPPED. Used by the
    // failure-injection scenarios #13–#15 where the SDK may surface a
    // transport/parse error whose phrasing is SDK-specific and not
    // abort-shaped. Implies (and requires) `ignoreThrown: true` — the
    // distinction from `ignoreThrown` alone is that ignoreThrown still
    // demands a `/abort|cancel/i` pattern match when a throw IS observed,
    // which is the right defensive posture for cancellation scenarios but
    // wrong for failure-injection scenarios. Do NOT widen this flag to
    // scenarios that don't deliberately inject a wire-level transport
    // failure — a non-cancel non-injection throw is exactly the rot this
    // harness exists to catch.
    tolerateThrownInjection: z.boolean().optional(),
    // Phase 6.5c: when true, the comparator skips hook firing order equality.
    // Used by scenario #9 (max_tokens) where the two SDKs structurally diverge
    // on auto-continuation: the Anthropic Agent SDK injects a synthetic
    // "Output token limit hit. Resume directly…" user message and fires a 2nd
    // turn automatically when stop_reason=max_tokens arrives, whereas the OR
    // /responses agent loop terminates after one response on status=completed/
    // incomplete with no continuation. The resulting per-side hook sequences
    // therefore differ in turn-bracket count. This flag opts that single
    // scenario out of the strict hook-order check so the parity claim that
    // CAN be made (both sides reach a terminal:success state without
    // throwing) is still asserted. Do NOT widen this flag to other scenarios
    // — a hook-order asymmetry on a non-max-tokens scenario is the kind of
    // rot this harness exists to catch. See PR body for the full divergence
    // finding + follow-up issue for emulator `response.incomplete` support
    // that would let this scenario tighten its assertion later.
    skipHookOrderCheck: z.boolean().optional(),
  })
  .optional();

export type ComparatorConfig = z.infer<typeof comparatorConfigSchema>;
export type FinalTextAssertion = z.infer<typeof finalTextAssertionSchema>;
export type ArgTolerance = z.infer<typeof argToleranceSchema>;

// ----- Tool + permission wiring (Phase 6.5a) -----
//
// Scenarios with tool calls declare the fixture names from `_tools.ts` and an
// optional `canUseToolPolicy` (used by scenario #4's permission-denial case).
// The harness reads these and wires both SDKs symmetrically:
//   - OR: `tools` option (filtered to scenario's set), `canUseTool` closure
//         that fires the policy.
//   - Anthropic: `mcpServers: { harness: ... }`, `allowedTools` filter,
//         `canUseTool` closure that mirrors the OR policy.

const harnessToolNameSchema = z.enum([
  'echo',
  'counter',
  'rm',
  'read',
  'write',
  'flakyFetch',
  'shell',
  'lookup',
]);

const canUseToolPolicySchema = z.array(
  z.discriminatedUnion('action', [
    z.object({ tool: harnessToolNameSchema, action: z.literal('allow') }),
    z.object({
      tool: harnessToolNameSchema,
      action: z.literal('deny'),
      // Deny message is canon per ambiguity call #4 — exact-text comparison
      // is the point of the parity assertion. Both SDKs receive the same
      // string back from canUseTool; the model's adaptation text is asserted
      // by the comparator's per-event positional equality.
      message: z.string().min(1),
    }),
  ]),
);

// Phase 6.5b: cancellation policy for scenario #6 (mid-stream abort).
// The harness watches each side's captured-event stream and calls
// `abortController.abort()` once the configured threshold has been reached
// on that side. Thresholds are PER-SDK because the two SDKs emit events at
// very different granularities:
//
//   - **OR side** yields per-chunk `text_delta` events on the
//     `AgentCoreEvent` async-iterable. A long streaming response chunked
//     with `interChunkDelayMs` produces one yielded event per chunk.
//   - **Anthropic side** yields coarse SDKMessage events: `system` (init),
//     one `assistant` message (typically carrying the full response text
//     unless `includePartialMessages` is set), then `result`. The default
//     captureAnthropic does NOT enable partial-message streaming, so
//     `afterEventsAnthropic: 2` aborts right after the assistant arrives.
//
// Authors set both numbers from observation; the harness's job is to
// translate them into deterministic `abortController.abort()` calls. The
// comparator's `ignoreThrown` + `skipTerminalCheck` + `skipEventStreamCheck`
// flags handle the resulting asymmetry on the comparison side.
const cancellationConfigSchema = z
  .object({
    /** Abort the Anthropic-side run after this many `SDKMessage` events arrive. */
    afterEventsAnthropic: z.number().int().positive(),
    /** Abort the OR-side run after this many `AgentCoreEvent` events arrive. */
    afterEventsOr: z.number().int().positive(),
  })
  .optional();

// Phase 6.9 backfill #154: enum intersection of OR `EffortLevel`
// (`xhigh|high|medium|low|minimal|none`) and the Claude Agent SDK's
// `EffortLevel` (`low|medium|high|xhigh|max`). The scenario JSON is wire-
// agnostic so only the values both SDKs accept are exposed here. Authors
// who need an SDK-specific value (`minimal`, `none`, `max`) can extend
// this enum then; v1 keeps it tight.
const scenarioEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);

// Scenario-level OR auto-prompt-cache directive. Matches the shape of
// `AnthropicCacheControlDirective` from `@openrouter/sdk/models` — thin
// passthrough with no defaulting. Threaded ONLY into the OR side of the
// harness today: the Claude Agent SDK has no top-level cacheControl knob
// (per-content-block `cache_control` lives on the SDK's `TextBlockParam`,
// not on `query()`'s `Options`), so the Anthropic side of a scenario
// using this field is a no-op — the canonical hash matches the no-cache
// case. See scenario #23's `description` for the documented asymmetry.
const scenarioCacheControlSchema = z.object({
  type: z.literal('ephemeral'),
  ttl: z.union([z.literal('5m'), z.literal('1h')]).optional(),
});

export const scenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  /**
   * Phase 6.9 backfill #154: forward a per-run reasoning-effort knob into
   * BOTH SDKs. The OR side flows it through `OpenRouterAgentRunOptions.effort`
   * → `reasoning: { effort }` on the `/responses` request body (canonicalized
   * by `script-engine.ts`'s `reasoning` field, so the request hash differs
   * from the same scenario without `effort` set). The Anthropic side flows
   * it through `query()`'s `Options.effort`; the SDK's request-body mapping
   * to `thinking` is NOT surfaced in the Anthropic canonical projection
   * (intentionally — see #154 PR body, ambiguity call), so the Anthropic
   * hash matches the no-effort case. The parity claim the scenario actually
   * makes is event-stream equality, NOT request-hash equality.
   */
  effort: scenarioEffortSchema.optional(),
  /**
   * Scenario-level OR auto-prompt-cache directive. Forwarded into the OR
   * side via `OpenRouterAgentRunOptions.cacheControl` → top-level
   * `cacheControl` field on the `callModel` request body. The OR canonical
   * projection (`script-engine.ts`) does NOT include `cache_control`, so
   * the hash matches the no-cacheControl case for the same prompt/model
   * combo — the parity claim this knob exercises is event-stream equality
   * with the option set on the OR side. The Anthropic side has no
   * equivalent request-level cache hint on `query()`'s `Options`, so this
   * field is a no-op on that wire (its hash also matches the no-cache
   * case). See scenario #23's `description` for the full asymmetry note.
   */
  cacheControl: scenarioCacheControlSchema.optional(),
  /**
   * Fixture tool names to register from `scenarios/_tools.ts`. Empty/omitted
   * means no tools (scenario #1's no-tool happy path). The harness builds
   * BOTH SDK-side bindings from this single declaration.
   */
  tools: z.array(harnessToolNameSchema).optional(),
  /** Policy applied by both SDKs' `canUseTool` closure. Per-tool allow/deny. */
  canUseToolPolicy: canUseToolPolicySchema.optional(),
  /** Phase 6.5b cancellation policy (scenario #6). */
  cancellation: cancellationConfigSchema,
  script: z.array(scriptEntrySchema).min(1),
  comparator: comparatorConfigSchema,
  // Phase 6.7: per-scenario budget cap for live mode. Sum of costUsd across
  // BOTH SDKs (Anthropic `result.total_cost_usd` + OR `session_end.costUsd`).
  // Default in the harness is $0.50; per-scenario override here when a flow
  // is known-pricier (multi-turn, long context). On breach the harness aborts
  // the run and emits a "flaky-scenario" warning — not a hard fail; live mode
  // is best-effort and budget breach is a signal to refresh the scenario, not
  // a merge blocker. Emulated-mode runs always report costUsd=0 so this knob
  // is a no-op in that mode.
  maxCostUsd: z.number().positive().optional(),
  // Phase 6.7: per-scenario harness-level timeout override. Default in the
  // harness is 30_000ms. Bump on a per-scenario basis when a SCRIPTED failure
  // path (e.g. scenarios #13/#15 — mid-stream 5xx and truncated stream) is
  // known to push past the default because the Anthropic SDK's internal retry
  // loop on `invalid_request_error` adds ~2-4s wall time on cold cache. DO NOT
  // widen the global default — keep the 30s ceiling so other slow scenarios
  // surface as failures rather than silently slowing CI.
  harnessTimeoutMs: z.number().int().positive().optional(),
  // Phase 6.7: include this scenario in the live-mode smoke subset that runs
  // on every non-draft, non-fork PR. The smoke set is intentionally small
  // (3-4 scenarios) and must fit under the $0.25/PR aggregate cap enforced
  // at the workflow level. Flag a scenario as `liveSmoke: true` only when
  // it covers a meaningfully distinct slice of the parity surface; everything
  // else stays nightly-only.
  liveSmoke: z.boolean().optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;

/** Load + validate a scenario JSON file from disk. */
export async function loadScenario(scenarioPath: string): Promise<Scenario> {
  const raw = await readFile(scenarioPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Scenario file ${scenarioPath} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = scenarioSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Scenario file ${scenarioPath} failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}

/**
 * Extract the script entries for a given wire format. Entries without `wire`
 * default to `anthropic` — same default as the emulator's script-engine.
 */
export function entriesForWire(
  scenario: Scenario,
  wire: 'anthropic' | 'openai' | 'openresponses',
): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  for (const entry of scenario.script) {
    const entryWire = entry.wire ?? 'anthropic';
    if (entryWire !== wire) continue;
    out.push(entry as ScriptEntry);
  }
  return out;
}
