// Comparator (Phase 6.4) — `exact` + `tolerant` modes.
//
// Consumes the two transcripts produced by 6.3's harness and returns a
// structured pass/fail verdict + a human-readable Markdown report. This is
// the load-bearing parity assertion — without it, the harness is just two
// concurrent runs with no comparison.
//
// === Mode semantics (do not relax without a PR-comment justification) ===
//
//   exact:    used in emulated runs. Canonical event sequence MUST match
//             positionally. Tool args MUST be structurally equal. Token
//             counts MUST match exactly (the emulator scripted them).
//             Terminal status MUST match. Hook order MUST match.
//
//   tolerant: used in live runs. Canonical event TYPES + their structural
//             skeleton MUST still match positionally, but: token counts
//             allowed within ±tokenTolerancePct (default 15%), final
//             assistant text NOT compared structurally (asserted via a
//             scenario-declared predicate), and flagged tool-args paths
//             allowed declared per-arg tolerance. Tool execution order +
//             hook firing order remain EXACT — that's the "model can phrase
//             its answer however, but the host's view of what the SDK did
//             must be identical" invariant from the plan doc.
//
// LLM-judge is documented as deferred per the issue body. v1 ships
// substring / regex / lengthRange final-text predicates only.
//
// TODO(6.5): scenario-declared deterministic-irrelevant ordering.
// TODO(6.5+): full hook-stream projection (see canonicalize.ts header).
// TODO(6.6): failure-injection asserts (status-code variants, retry
//   sequencing) — v1 only compares the canonical event stream.
// TODO(deferred): LLM-judge final-text predicate.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  canonicalizeAnthropic,
  canonicalizeOr,
  type CanonicalEvent,
  type Projection,
} from './canonicalize.js';
import type { ArgTolerance, ComparatorConfig, FinalTextAssertion, Scenario } from './scenarios.js';
import type { AnthropicTranscript, OrTranscript } from './transcript.js';

export interface CompareResult {
  /** Overall verdict. `true` only if every assertion passed. */
  pass: boolean;
  /** Human-readable Markdown report. Always populated. */
  report: string;
  /** Structured failure list — empty on pass. */
  failures: ReadonlyArray<Failure>;
  /** Index of the first diverging canonical event (`-1` if no event-stream divergence). */
  firstDivergentIndex: number;
}

export interface Failure {
  kind:
    | 'event_count'
    | 'event_type'
    | 'event_payload'
    | 'tool_call_count'
    | 'tool_call_name'
    | 'tool_call_args'
    | 'token_usage'
    | 'terminal_status'
    | 'final_text'
    | 'hook_order'
    | 'thrown';
  detail: string;
  /** Canonical event index when relevant; -1 otherwise. */
  index: number;
}

export interface CompareOptions {
  /** Scenario name — only used for the report header + failure dump dir. */
  scenarioName: string;
  /** Override the failure-dump root. Defaults to `<cwd>/tmp/comparative-failures`. */
  failureDumpRoot?: string;
  /** Disable on-disk failure dump (used by tests that don't want to litter `tmp/`). */
  dumpOnFail?: boolean;
}

const DEFAULT_TOKEN_TOLERANCE_PCT = 15;

/**
 * Compare two transcripts under a scenario's comparator config and return a
 * structured pass/fail verdict + Markdown report. The function NEVER throws
 * — even on populated `thrown` fields, malformed projections, or missing
 * config (defaults to exact mode with the standard mask set). Throws are
 * caught and surfaced as failures so the caller (a vitest `it` block) sees
 * a deterministic result.
 *
 * `compareTranscripts` may write a failure dump to disk (markdown + raw
 * transcripts) when `opts.dumpOnFail` is unset OR true. Pass `false` from
 * tests to keep `tmp/` clean.
 */
export async function compareTranscripts(
  anthropic: AnthropicTranscript,
  or: OrTranscript,
  config: ComparatorConfig,
  opts: CompareOptions,
): Promise<CompareResult> {
  // Default to exact mode if the scenario omits the comparator block — the
  // emulated harness is the primary consumer, and exact is the stricter
  // default; a tolerant run that forgot to declare itself would silently
  // weaken the parity claim.
  const mode = config?.mode ?? 'exact';
  const extraIgnore = new Set<string>(config?.ignore ?? []);
  const tokenTolerancePct = config?.tokenTolerancePct ?? DEFAULT_TOKEN_TOLERANCE_PCT;

  const anthProj = canonicalizeAnthropic(anthropic, extraIgnore);
  const orProj = canonicalizeOr(or, extraIgnore);

  const failures: Failure[] = [];

  // Thrown handling: when either side threw, we surface that as a failure
  // and still try to produce a comparison from whatever events DID get
  // captured. The smoke scenario currently hits this path on both sides
  // (Anthropic 500 from emulator_script_miss, OR 404 from missing
  // /responses adapter) — see PR-body ambiguity call.
  //
  // Phase 6.5b: `ignoreThrown` is honored when the scenario declares it on
  // the comparator config. Cancellation scenarios deliberately abort both
  // SDKs mid-stream, populating `thrown` on both sides; the parity claim
  // there is that the runs were both terminated, not that they completed
  // cleanly. Do NOT widen this to other scenarios — silent throws on
  // happy-path runs are the rot this harness exists to catch.
  const ignoreThrown = config?.ignoreThrown === true;
  if (!ignoreThrown) {
    if (anthProj.thrown) {
      failures.push({
        kind: 'thrown',
        detail: `Anthropic-side threw: ${truncate(anthProj.thrown, 400)}`,
        index: -1,
      });
    }
    if (orProj.thrown) {
      failures.push({
        kind: 'thrown',
        detail: `OpenRouter-side threw: ${truncate(orProj.thrown, 400)}`,
        index: -1,
      });
    }
  }

  // Event-stream comparison. Type + payload equality is positional; first
  // divergence reported via `firstDivergentIndex`. Phase 6.5b cancellation
  // scenarios may declare `skipEventStreamCheck` to opt out — the two SDKs'
  // text-delta granularity differs (Anthropic batches text into one
  // assistant message; OR emits per-chunk `text_delta`), so positional
  // text comparison can never match mid-stream even on identical wire
  // payloads. The hook-order check below stays exact in both modes.
  const skipEventStream = config?.skipEventStreamCheck === true;
  const firstDivergentIndex = skipEventStream
    ? -1
    : compareEventStreams(anthProj.events, orProj.events, mode, config, failures);

  // Tool-call comparison (already covered structurally by the event stream,
  // but we add explicit per-call diagnostics so the failure report flags
  // them by name + path rather than "event[3] differs"). Skipped alongside
  // the event-stream check when `skipEventStreamCheck` is set — tool calls
  // are part of the event stream and the same rationale applies.
  if (!skipEventStream) {
    compareToolCalls(anthProj.toolCalls, orProj.toolCalls, mode, config, failures);
  }

  // Token usage. Exact in exact mode; band in tolerant mode. Skipped on
  // cancellation scenarios that declare `skipTerminalCheck` — aborted runs
  // have no usage to report and the SDKs differ on whether they emit zeros
  // or a missing terminal entirely.
  const skipTerminal = config?.skipTerminalCheck === true;
  if (!skipTerminal) {
    compareTokenUsage(anthProj.tokenUsage, orProj.tokenUsage, mode, tokenTolerancePct, failures);
  }

  // Terminal status — exact in BOTH modes by default. Cancellation scenarios
  // skip this: OR's `stream_complete` may not fire at all on abort (leaving
  // `terminalStatus` null), while Anthropic emits `result.subtype = 'error'`
  // when the iterator throws — a structural asymmetry that is not the parity
  // claim this scenario is trying to make. `ignoreThrown` covers the
  // throw-vs-no-throw side of the same asymmetry.
  if (!skipTerminal && anthProj.terminalStatus !== orProj.terminalStatus) {
    failures.push({
      kind: 'terminal_status',
      detail: `Terminal status mismatch: anthropic=${String(anthProj.terminalStatus)} or=${String(orProj.terminalStatus)}`,
      index: -1,
    });
  }

  // Hook firing order — exact in BOTH modes. This is the load-bearing
  // parity claim; do not relax. Phase 6.5c scenario #9 is the documented
  // exception: max_tokens triggers Anthropic auto-continuation while the OR
  // /responses loop terminates, so the per-side hook sequences structurally
  // differ. The `skipHookOrderCheck` flag opts that single scenario out;
  // every other scenario must agree exactly.
  const skipHookOrder = config?.skipHookOrderCheck === true;
  if (!skipHookOrder && !arraysEqual(anthProj.hookOrder, orProj.hookOrder)) {
    failures.push({
      kind: 'hook_order',
      detail: `Hook firing order mismatch:\n  anthropic: [${anthProj.hookOrder.join(', ')}]\n  or:        [${orProj.hookOrder.join(', ')}]`,
      index: -1,
    });
  }

  // Final-text assertion: in exact mode we require positional event equality
  // (already enforced by compareEventStreams); in tolerant mode we apply
  // the scenario's predicate against the OR-side concatenated text — the
  // Anthropic side is reference but the host (OR) is the parity target.
  if (mode === 'tolerant' && config?.finalTextAssertion) {
    const predicateResult = applyFinalTextPredicate(orProj.finalText, config.finalTextAssertion);
    if (!predicateResult.ok) {
      failures.push({
        kind: 'final_text',
        detail: predicateResult.detail,
        index: -1,
      });
    }
  }

  const pass = failures.length === 0;
  const report = buildReport({
    scenarioName: opts.scenarioName,
    mode,
    pass,
    failures,
    firstDivergentIndex,
    anthProj,
    orProj,
    anthropic,
    or,
  });

  if (!pass && opts.dumpOnFail !== false) {
    await dumpFailure(opts, report, anthropic, or);
  }

  return { pass, report, failures, firstDivergentIndex };
}

/**
 * Convenience wrapper: pull the comparator config off the scenario and
 * dispatch. Useful for the `describe.each` driver in 6.5+ where the test
 * has the scenario in hand.
 */
export function compareTranscriptsFromScenario(
  scenario: Scenario,
  anthropic: AnthropicTranscript,
  or: OrTranscript,
  opts?: Partial<CompareOptions>,
): Promise<CompareResult> {
  return compareTranscripts(anthropic, or, scenario.comparator, {
    scenarioName: scenario.name,
    ...opts,
  });
}

// ----- Event stream comparison -----

function compareEventStreams(
  anth: CanonicalEvent[],
  or: CanonicalEvent[],
  mode: 'exact' | 'tolerant',
  config: ComparatorConfig,
  failures: Failure[],
): number {
  if (anth.length !== or.length) {
    failures.push({
      kind: 'event_count',
      detail: `Event count mismatch: anthropic=${anth.length} or=${or.length}`,
      index: Math.min(anth.length, or.length),
    });
  }
  let firstDivergent = -1;
  const len = Math.min(anth.length, or.length);
  for (let i = 0; i < len; i++) {
    const a = anth[i]!;
    const o = or[i]!;
    if (a.type !== o.type) {
      failures.push({
        kind: 'event_type',
        detail: `event[${i}] type mismatch: anthropic=${a.type} or=${o.type}`,
        index: i,
      });
      if (firstDivergent === -1) firstDivergent = i;
      continue;
    }
    const eq = eventsEqual(a, o, mode, config);
    if (!eq.ok) {
      failures.push({
        kind: eq.kind,
        detail: `event[${i}] (${a.type}) payload mismatch: ${eq.detail}`,
        index: i,
      });
      if (firstDivergent === -1) firstDivergent = i;
    }
  }
  if (firstDivergent === -1 && anth.length !== or.length) {
    firstDivergent = len;
  }
  return firstDivergent;
}

function eventsEqual(
  a: CanonicalEvent,
  b: CanonicalEvent,
  mode: 'exact' | 'tolerant',
  config: ComparatorConfig,
): { ok: true } | { ok: false; kind: Failure['kind']; detail: string } {
  // Type already matched by caller; switch on `a.type` for narrowing.
  switch (a.type) {
    case 'session_start':
      return { ok: true };
    case 'turn_start': {
      const bb = b as Extract<CanonicalEvent, { type: 'turn_start' }>;
      if (a.turnNumber !== bb.turnNumber) {
        return {
          ok: false,
          kind: 'event_payload',
          detail: `turnNumber ${a.turnNumber} vs ${bb.turnNumber}`,
        };
      }
      return { ok: true };
    }
    case 'text': {
      const bb = b as Extract<CanonicalEvent, { type: 'text' }>;
      if (mode === 'tolerant') {
        // Tolerant mode: text predicates are aggregate (final-text), not
        // per-delta. Per-event text divergence is informational.
        return { ok: true };
      }
      if (a.text !== bb.text) {
        return {
          ok: false,
          kind: 'event_payload',
          detail: `text differs (${jsonShort(a.text)} vs ${jsonShort(bb.text)})`,
        };
      }
      return { ok: true };
    }
    case 'tool_call': {
      const bb = b as Extract<CanonicalEvent, { type: 'tool_call' }>;
      if (a.name !== bb.name) {
        return {
          ok: false,
          kind: 'tool_call_name',
          detail: `name ${a.name} vs ${bb.name}`,
        };
      }
      const argsOk = compareToolArgs(a.name, a.args, bb.args, mode, config);
      if (!argsOk.ok) {
        return { ok: false, kind: 'tool_call_args', detail: argsOk.detail };
      }
      return { ok: true };
    }
    case 'tool_result': {
      const bb = b as Extract<CanonicalEvent, { type: 'tool_result' }>;
      if (a.isError !== bb.isError) {
        return {
          ok: false,
          kind: 'event_payload',
          detail: `isError ${a.isError} vs ${bb.isError}`,
        };
      }
      return { ok: true };
    }
    case 'turn_end':
      return { ok: true };
    case 'terminal': {
      const bb = b as Extract<CanonicalEvent, { type: 'terminal' }>;
      if (a.status !== bb.status) {
        return {
          ok: false,
          kind: 'terminal_status',
          detail: `status ${a.status} vs ${bb.status}`,
        };
      }
      // Token usage on the terminal event is asserted by the aggregate
      // token-usage check, not per-event — keeps the failure list from
      // double-reporting the same divergence.
      return { ok: true };
    }
    case 'error': {
      const bb = b as Extract<CanonicalEvent, { type: 'error' }>;
      if (a.message !== bb.message) {
        return {
          ok: false,
          kind: 'event_payload',
          detail: `error message differs (${jsonShort(a.message)} vs ${jsonShort(bb.message)})`,
        };
      }
      return { ok: true };
    }
  }
}

// ----- Tool args comparison (handles per-arg tolerances) -----

function compareToolArgs(
  toolName: string,
  a: unknown,
  b: unknown,
  mode: 'exact' | 'tolerant',
  config: ComparatorConfig,
): { ok: true } | { ok: false; detail: string } {
  if (mode === 'exact') {
    return structuralEqual(a, b)
      ? { ok: true }
      : { ok: false, detail: `args differ: ${jsonShort(a)} vs ${jsonShort(b)}` };
  }
  // Tolerant mode: walk both args trees in parallel; at each leaf, look up
  // the dot-path under `argTolerances[<toolName>.<path>]` and apply the
  // declared tolerance. Unflagged leaves require structural equality.
  const tolerances = config?.argTolerances ?? {};
  const result = compareWithTolerances(a, b, '', toolName, tolerances);
  return result.ok ? { ok: true } : { ok: false, detail: result.detail };
}

function compareWithTolerances(
  a: unknown,
  b: unknown,
  path: string,
  toolName: string,
  tolerances: Record<string, ArgTolerance>,
): { ok: true } | { ok: false; detail: string } {
  const tolKey = path === '' ? toolName : `${toolName}.${path}`;
  const tolerance = tolerances[tolKey];
  if (tolerance) {
    return applyArgTolerance(a, b, tolerance, tolKey);
  }
  // No tolerance flagged at this path — descend if both sides are
  // objects/arrays; otherwise require strict equality.
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b
      ? { ok: true }
      : { ok: false, detail: `arg[${path || '<root>'}]: ${jsonShort(a)} vs ${jsonShort(b)}` };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return {
        ok: false,
        detail: `arg[${path || '<root>'}]: array length ${a.length} vs ${b.length}`,
      };
    }
    for (let i = 0; i < a.length; i++) {
      const r = compareWithTolerances(a[i], b[i], `${path}[${i}]`, toolName, tolerances);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
      return {
        ok: false,
        detail: `arg[${path || '<root>'}]: keys differ ${jsonShort(aKeys)} vs ${jsonShort(bKeys)}`,
      };
    }
    for (const k of aKeys) {
      const r = compareWithTolerances(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path === '' ? k : `${path}.${k}`,
        toolName,
        tolerances,
      );
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return a === b
    ? { ok: true }
    : { ok: false, detail: `arg[${path || '<root>'}]: ${jsonShort(a)} vs ${jsonShort(b)}` };
}

function applyArgTolerance(
  a: unknown,
  b: unknown,
  tolerance: ArgTolerance,
  tolKey: string,
): { ok: true } | { ok: false; detail: string } {
  switch (tolerance.type) {
    case 'anyString':
      if (typeof a === 'string' && typeof b === 'string') return { ok: true };
      return {
        ok: false,
        detail: `arg[${tolKey}]: anyString tolerance requires strings on both sides`,
      };
    case 'substring': {
      if (typeof a !== 'string' || typeof b !== 'string') {
        return { ok: false, detail: `arg[${tolKey}]: substring tolerance requires strings` };
      }
      if (!a.includes(tolerance.value) || !b.includes(tolerance.value)) {
        return {
          ok: false,
          detail: `arg[${tolKey}]: substring '${tolerance.value}' missing in one side`,
        };
      }
      return { ok: true };
    }
    case 'numericDelta': {
      if (typeof a !== 'number' || typeof b !== 'number') {
        return { ok: false, detail: `arg[${tolKey}]: numericDelta tolerance requires numbers` };
      }
      if (Math.abs(a - b) > tolerance.delta) {
        return {
          ok: false,
          detail: `arg[${tolKey}]: numeric diff ${Math.abs(a - b)} exceeds delta ${tolerance.delta}`,
        };
      }
      return { ok: true };
    }
  }
}

// ----- Tool-call list comparison (counts + per-call diagnostics) -----

function compareToolCalls(
  anthCalls: Array<{ name: string; args: unknown }>,
  orCalls: Array<{ name: string; args: unknown }>,
  mode: 'exact' | 'tolerant',
  config: ComparatorConfig,
  failures: Failure[],
): void {
  if (anthCalls.length !== orCalls.length) {
    failures.push({
      kind: 'tool_call_count',
      detail: `Tool-call count mismatch: anthropic=${anthCalls.length} or=${orCalls.length}`,
      index: -1,
    });
    return;
  }
  for (let i = 0; i < anthCalls.length; i++) {
    const a = anthCalls[i]!;
    const o = orCalls[i]!;
    if (a.name !== o.name) {
      failures.push({
        kind: 'tool_call_name',
        detail: `tool_call[${i}] name mismatch: ${a.name} vs ${o.name}`,
        index: -1,
      });
      continue;
    }
    const argsOk = compareToolArgs(a.name, a.args, o.args, mode, config);
    if (!argsOk.ok) {
      failures.push({
        kind: 'tool_call_args',
        detail: `tool_call[${i}] (${a.name}) args mismatch: ${argsOk.detail}`,
        index: -1,
      });
    }
  }
}

// ----- Token usage -----

function compareTokenUsage(
  anth: { input: number; output: number },
  or: { input: number; output: number },
  mode: 'exact' | 'tolerant',
  tolerancePct: number,
  failures: Failure[],
): void {
  if (mode === 'exact') {
    if (anth.input !== or.input || anth.output !== or.output) {
      failures.push({
        kind: 'token_usage',
        detail: `Token usage mismatch (exact): anthropic=${JSON.stringify(anth)} or=${JSON.stringify(or)}`,
        index: -1,
      });
    }
    return;
  }
  // Tolerant: ±tolerancePct band. The band is computed against the
  // anthropic reference (it's the SDK whose live behavior we're matching
  // against). When the reference is 0, allow only an exact-0 match —
  // otherwise the band collapses to 0 and any nonzero OR side is flagged.
  if (!withinBand(anth.input, or.input, tolerancePct)) {
    failures.push({
      kind: 'token_usage',
      detail: `Token input out of band ±${tolerancePct}%: anthropic=${anth.input} or=${or.input}`,
      index: -1,
    });
  }
  if (!withinBand(anth.output, or.output, tolerancePct)) {
    failures.push({
      kind: 'token_usage',
      detail: `Token output out of band ±${tolerancePct}%: anthropic=${anth.output} or=${or.output}`,
      index: -1,
    });
  }
}

function withinBand(reference: number, actual: number, tolerancePct: number): boolean {
  if (reference === 0) return actual === 0;
  const allowedDelta = (reference * tolerancePct) / 100;
  return Math.abs(actual - reference) <= allowedDelta;
}

// ----- Final-text predicate -----

function applyFinalTextPredicate(
  text: string,
  predicate: FinalTextAssertion,
): { ok: true } | { ok: false; detail: string } {
  switch (predicate.type) {
    case 'substring':
      return text.includes(predicate.value)
        ? { ok: true }
        : { ok: false, detail: `final-text predicate (substring '${predicate.value}') failed` };
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(predicate.value);
      } catch (err) {
        return {
          ok: false,
          detail: `final-text predicate (regex '${predicate.value}') invalid: ${(err as Error).message}`,
        };
      }
      return re.test(text)
        ? { ok: true }
        : { ok: false, detail: `final-text predicate (regex '${predicate.value}') did not match` };
    }
    case 'lengthRange': {
      const len = text.length;
      if (predicate.min !== undefined && len < predicate.min) {
        return { ok: false, detail: `final-text length ${len} < min ${predicate.min}` };
      }
      if (predicate.max !== undefined && len > predicate.max) {
        return { ok: false, detail: `final-text length ${len} > max ${predicate.max}` };
      }
      return { ok: true };
    }
  }
}

// ----- Markdown report -----

interface ReportInput {
  scenarioName: string;
  mode: 'exact' | 'tolerant';
  pass: boolean;
  failures: Failure[];
  firstDivergentIndex: number;
  anthProj: Projection;
  orProj: Projection;
  anthropic: AnthropicTranscript;
  or: OrTranscript;
}

function buildReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# Comparator report: ${input.scenarioName}`);
  lines.push('');
  lines.push(`- Mode: \`${input.mode}\``);
  lines.push(`- Result: ${input.pass ? '**PASS**' : '**FAIL**'}`);
  lines.push(`- First divergent event index: ${input.firstDivergentIndex}`);
  lines.push(`- Anthropic event count: ${input.anthProj.events.length}`);
  lines.push(`- OR event count: ${input.orProj.events.length}`);
  lines.push('');

  if (input.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const f of input.failures) {
      lines.push(`- **${f.kind}**${f.index >= 0 ? ` @ event[${f.index}]` : ''}: ${f.detail}`);
    }
    lines.push('');
  }

  lines.push('## Side-by-side canonical events');
  lines.push('');
  lines.push('| idx | anthropic | openrouter | match |');
  lines.push('| --- | --- | --- | --- |');
  const maxLen = Math.max(input.anthProj.events.length, input.orProj.events.length);
  for (let i = 0; i < maxLen; i++) {
    const a = input.anthProj.events[i];
    const o = input.orProj.events[i];
    const aCell = a ? eventCell(a) : '_(none)_';
    const oCell = o ? eventCell(o) : '_(none)_';
    const matched = a && o && eventCell(a) === eventCell(o) ? 'OK' : 'DIFF';
    const marker = i === input.firstDivergentIndex ? ' **<-- first divergence**' : '';
    lines.push(`| ${i} | ${aCell} | ${oCell} | ${matched}${marker} |`);
  }
  lines.push('');

  lines.push('## Aggregates');
  lines.push('');
  lines.push(`- Anthropic terminal: \`${String(input.anthProj.terminalStatus)}\``);
  lines.push(`- OR terminal: \`${String(input.orProj.terminalStatus)}\``);
  lines.push(
    `- Anthropic tokens: input=${input.anthProj.tokenUsage.input} output=${input.anthProj.tokenUsage.output}`,
  );
  lines.push(
    `- OR tokens: input=${input.orProj.tokenUsage.input} output=${input.orProj.tokenUsage.output}`,
  );
  lines.push(`- Anthropic hook order: [${input.anthProj.hookOrder.join(', ')}]`);
  lines.push(`- OR hook order: [${input.orProj.hookOrder.join(', ')}]`);
  lines.push('');

  if (input.anthProj.thrown || input.orProj.thrown) {
    lines.push('## Thrown');
    lines.push('');
    if (input.anthProj.thrown) {
      lines.push('### Anthropic-side');
      lines.push('```');
      lines.push(truncate(input.anthProj.thrown, 1000));
      lines.push('```');
    }
    if (input.orProj.thrown) {
      lines.push('### OpenRouter-side');
      lines.push('```');
      lines.push(truncate(input.orProj.thrown, 1000));
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('## Full transcripts');
  lines.push('');
  lines.push('### Anthropic');
  lines.push('```json');
  lines.push(JSON.stringify(input.anthropic, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### OpenRouter');
  lines.push('```json');
  lines.push(JSON.stringify(input.or, null, 2));
  lines.push('```');
  return lines.join('\n');
}

function eventCell(ev: CanonicalEvent): string {
  switch (ev.type) {
    case 'session_start':
      return '`session_start`';
    case 'turn_start':
      return `\`turn_start\`(t=${ev.turnNumber})`;
    case 'text':
      return `\`text\`(${jsonShort(ev.text)})`;
    case 'tool_call':
      return `\`tool_call\`(${ev.name}, ${jsonShort(ev.args)})`;
    case 'tool_result':
      return `\`tool_result\`(isError=${ev.isError})`;
    case 'turn_end':
      return '`turn_end`';
    case 'terminal':
      return `\`terminal\`(${ev.status})`;
    case 'error':
      return `\`error\`(${jsonShort(ev.message)})`;
  }
}

// ----- Failure dump -----

async function dumpFailure(
  opts: CompareOptions,
  report: string,
  anthropic: AnthropicTranscript,
  or: OrTranscript,
): Promise<void> {
  // process.cwd() is taboo in production code per the project's hard
  // invariants — but this is test infrastructure under
  // `src/__tests__/comparative/` and the harness already uses the same
  // pattern (see harness.ts:117). Tests can override via
  // `opts.failureDumpRoot` to avoid cluttering `tmp/`.
  const root = opts.failureDumpRoot ?? join(process.cwd(), 'tmp', 'comparative-failures');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, `${opts.scenarioName}-${timestamp}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.md'), report, 'utf8');
  await writeFile(
    join(dir, 'anthropic.transcript.json'),
    JSON.stringify(anthropic, null, 2),
    'utf8',
  );
  await writeFile(join(dir, 'or.transcript.json'), JSON.stringify(or, null, 2), 'utf8');
}

// ----- Utility -----

function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => structuralEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => structuralEqual(aObj[k], bObj[k]));
}

function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function jsonShort(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}
