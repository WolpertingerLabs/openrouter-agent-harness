// Transcript projection for the Phase 6.4 comparator.
//
// The two SDKs' transcripts have different shapes by design (Anthropic
// `messages` vs. OR `AgentCoreEvent[]`). The comparator never compares them
// raw — it projects each side to a SHARED `CanonicalEvent[]` sequence plus a
// small bag of aggregates (final text, tool calls, token usage, terminal
// status), and compares the projections.
//
// === What "canonicalization" does (load-bearing) ===
//
//   1. Strip every nondeterministic field documented in `transcript.ts`'s
//      `MASKED_KEYS` (the harness already masked these at capture time — this
//      module's mask pass is a defensive second sweep that ALSO honors the
//      scenario-level `ignore` extension).
//   2. Strip every `toolu_*` / `call_*` ID anywhere in the tree. These vary
//      between SDKs and provide no parity signal.
//   3. Project each transcript to an ordered `CanonicalEvent[]` whose
//      vocabulary is identical across sides. Order is meaningful — the
//      comparator's exact-mode equality is positional.
//   4. Extract aggregates (final text concat, tool-call list, token usage,
//      terminal status, hook event order) that the tolerant comparator's
//      band/predicate logic operates on.
//
// Tolerance bands and final-text predicates are NOT applied here — they're
// the comparator's job in tolerant mode. This module produces deterministic
// projections; the comparator decides which fields get exact-vs-tolerant
// treatment.
//
// TODO(6.5): scenario-declared deterministic-irrelevant ordering (e.g.
//   parallel-subagent kickoff order) — v1 always treats order as meaningful.
// TODO(6.5+): hook-stream projection. v1 derives "hook firing order" from
//   the structural stream events (`session_start` ≈ SessionStart,
//   `turn_start` ≈ PreToolUse-bracket, `terminal` ≈ SessionEnd/Stop), per
//   the 6.3 harness header note that hooks-as-such aren't separately
//   captured. When 6.5 grows the harness to capture the hook stream, this
//   projector should fold it in alongside the stream events.

import type { AgentCoreEvent } from '../../events.js';

import type { AnthropicTranscript, OrTranscript } from './transcript.js';

/**
 * Canonical event vocabulary the comparator operates on. Both SDKs project
 * down to this — the field set is intentionally minimal so projection is
 * lossy in only one direction (toward "is this the same shape of run").
 *
 * `tool_call.args` is the structurally-cloned input (with `toolu_*`/`call_*`
 * IDs stripped and nondeterministic keys masked). `terminal.usage` is the
 * normalized `{ input, output }` token pair extracted from whichever shape
 * the SDK exposes (`input_tokens`/`output_tokens` on Anthropic; `Usage`
 * fields on OR).
 */
export type CanonicalEvent =
  | { type: 'session_start' }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; isError: boolean }
  | { type: 'turn_end' }
  | {
      type: 'terminal';
      status: string;
      usage: { input: number; output: number } | null;
    }
  | { type: 'error'; message: string };

export interface Projection {
  /** Ordered canonical event sequence — positional equality is meaningful. */
  events: CanonicalEvent[];
  /** Final assistant text (concatenation of every text event, in order). */
  finalText: string;
  /** Tool calls in invocation order. `args` is the masked input. */
  toolCalls: Array<{ name: string; args: unknown }>;
  /** Normalized token usage (zeros when the SDK never emitted a result). */
  tokenUsage: { input: number; output: number };
  /** Terminal status string (e.g. `'success'`, `'end_turn'`, `'error'`). */
  terminalStatus: string | null;
  /** Hook-equivalent event order (the structural-event subset, per file note). */
  hookOrder: string[];
  /** Captured `thrown` from the transcript, if the SDK threw. */
  thrown: string | undefined;
}

/**
 * Project an OR transcript to a canonical projection.
 *
 * `extraIgnore` is the scenario's `comparator.ignore` extension — added on
 * top of the hard-coded mask set already applied by the harness.
 */
export function canonicalizeOr(
  transcript: OrTranscript,
  extraIgnore: ReadonlySet<string> = new Set(),
): Projection {
  const events: CanonicalEvent[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const hookOrder: string[] = [];
  const textParts: string[] = [];
  let tokenUsage: { input: number; output: number } = { input: 0, output: 0 };
  let terminalStatus: string | null = null;

  // Turn-bracket synthesis (Phase 6.5a): the OR SDK only emits `turn_start` /
  // `turn_end` events on multi-step tool flows where its internal step
  // counter advances. Single-turn no-tool responses skip the bracket — but
  // the Anthropic projection ALWAYS emits a bracket per assistant message
  // (text or tool_use). To get aligned projections, synthesize a turn bracket
  // on the OR side around the first content event when the SDK didn't emit
  // one. Emit at most one synthesized turn_start per detected "turn-worth"
  // of content (delimited by tool_result, since the next-turn boundary is
  // unambiguously after the tool returns).
  let bracketOpen = false;
  let bracketTurnNumber = 0;
  let usedRealBracket = false;
  const openBracketIfNeeded = (): void => {
    if (!usedRealBracket && !bracketOpen) {
      events.push({ type: 'turn_start', turnNumber: bracketTurnNumber });
      hookOrder.push('turn_start');
      bracketOpen = true;
    }
  };
  const closeBracketIfOpen = (): void => {
    if (!usedRealBracket && bracketOpen) {
      events.push({ type: 'turn_end' });
      hookOrder.push('turn_end');
      bracketOpen = false;
      bracketTurnNumber += 1;
    }
  };

  for (const raw of transcript.events) {
    const ev = stripIds(raw, extraIgnore) as AgentCoreEvent;
    switch (ev.type) {
      case 'session_started':
        events.push({ type: 'session_start' });
        hookOrder.push('session_start');
        break;
      case 'turn_start':
        // The SDK emitted a real turn_start — fall back to that and stop
        // synthesizing brackets for the remainder of this transcript.
        usedRealBracket = true;
        events.push({ type: 'turn_start', turnNumber: ev.turnNumber });
        hookOrder.push('turn_start');
        break;
      case 'text_delta':
        openBracketIfNeeded();
        textParts.push(ev.content);
        events.push({ type: 'text', text: ev.content });
        break;
      case 'tool_call': {
        openBracketIfNeeded();
        const args = stripIds(ev.input, extraIgnore);
        events.push({ type: 'tool_call', name: ev.name, args });
        toolCalls.push({ name: ev.name, args });
        hookOrder.push(`tool_call:${ev.name}`);
        break;
      }
      case 'tool_result':
        events.push({ type: 'tool_result', isError: ev.isError });
        hookOrder.push('tool_result');
        break;
      case 'turn_end':
        usedRealBracket = true;
        events.push({ type: 'turn_end' });
        // Per-turn usage on `turn_end` is null on the OR SDK in practice
        // (the SDK forwards `finalUsage` which isn't populated until
        // `getResponse()` resolves). Token accounting flows through the
        // terminal `stream_complete` event instead — see below.
        hookOrder.push('turn_end');
        break;
      case 'stream_complete': {
        closeBracketIfOpen();
        // Phase 6.5b: map `status: 'error'` + `reason: 'aborted'` to a
        // canonical `terminal:aborted` so the cancellation scenario's
        // Anthropic-side synthetic `terminal:aborted` (emitted when the SDK
        // throws and never produces a `result` message) aligns with what
        // the OR side reports. Other error statuses (genuine runtime
        // failures, max_turns, etc.) keep their literal status string.
        const isAbort =
          ev.status === 'error' && typeof ev.reason === 'string' && /abort/i.test(ev.reason);
        const canonicalStatus = isAbort ? 'aborted' : ev.status;
        terminalStatus = canonicalStatus;
        // `stream_complete.usage` carries the LAST turn's usage. The
        // Anthropic side reads per-turn usage off the final assistant
        // message (NOT cumulative `result.usage`), so both sides agree at
        // last-turn granularity. Cross-turn accounting is genuinely
        // asymmetric between the two SDKs and trying to compare cumulatively
        // would force divergence the comparator can't actually assert.
        const usage = ev.usage ? orUsageToCanon(ev.usage) : tokenUsage;
        events.push({ type: 'terminal', status: canonicalStatus, usage });
        hookOrder.push(`terminal:${canonicalStatus}`);
        tokenUsage = usage;
        break;
      }
      case 'message_item_start':
        // OR-only, purely additive output-item boundary marker (see the
        // `message_item_start` block in src/events.ts). It carries no
        // content — it only tells a downstream consumer where one `message`
        // /`reasoning` item ends and the next begins so a live renderer can
        // flush its bubble. The Anthropic SDK exposes no equivalent signal
        // (it coalesces an assistant turn into a single `assistant`
        // message), so there is nothing on the other side to compare it
        // against. Drop it from the projection: the following `text_delta`
        // /`reasoning_delta` still carries the content, and the turn-bracket
        // synthesis above still opens on that delta, so the projection is
        // byte-identical to the pre-boundary-event behavior.
        //
        // Deliberately NOT `openBracketIfNeeded()`: a `reasoning`-kind
        // boundary can be emitted for an item the comparator projects no
        // content for, which would open a bracket that never closes.
        //
        // This is an explicit case rather than a `default` fallthrough on
        // purpose — the `default` branch below must stay loud so a genuinely
        // unknown future event still surfaces as a divergence instead of
        // being silently swallowed.
        break;
      case 'error':
        events.push({ type: 'error', message: ev.message });
        hookOrder.push('error');
        break;
      default:
        // Forward-compat: unknown event types are projected to a stable
        // pseudo-error so divergence is loud, not silent.
        events.push({
          type: 'error',
          message: `unknown_or_event:${(ev as { type: string }).type}`,
        });
    }
  }
  closeBracketIfOpen();

  return {
    events,
    finalText: textParts.join(''),
    toolCalls,
    tokenUsage,
    terminalStatus,
    hookOrder,
    thrown: transcript.thrown,
  };
}

/**
 * Project an Anthropic transcript to a canonical projection.
 *
 * The Anthropic SDK's `SDKMessage` union is wide — we walk it defensively
 * and pick out the structural events that have an OR counterpart. Unknown
 * messages are skipped (NOT projected to error) because the SDK emits many
 * status/lifecycle messages that don't map to OR's stream events — folding
 * them into the canonical stream would force divergence on noise.
 */
export function canonicalizeAnthropic(
  transcript: AnthropicTranscript,
  extraIgnore: ReadonlySet<string> = new Set(),
): Projection {
  const events: CanonicalEvent[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const hookOrder: string[] = [];
  const textParts: string[] = [];
  let tokenUsage: { input: number; output: number } = { input: 0, output: 0 };
  let terminalStatus: string | null = null;
  let sessionStartedEmitted = false;
  // The Anthropic SDK splits a single agent turn across multiple top-level
  // messages: `assistant` (model output, may carry tool_use) → `user`
  // (tool_result) → next `assistant` (next turn or final text). The OR
  // runtime emits a single `turn_start`/`turn_end` bracket that spans the
  // full iteration including the tool_result. To get matching projections,
  // we DEFER the `turn_end` emission until the next turn_start (new
  // assistant message) or the terminal `result` — so tool_result events
  // from the user message land INSIDE the bracket, mirroring OR.
  let turnOpen = false;
  const closeTurn = (): void => {
    if (turnOpen) {
      events.push({ type: 'turn_end' });
      hookOrder.push('turn_end');
      turnOpen = false;
    }
  };

  for (const raw of transcript.messages) {
    const msg = stripIds(raw, extraIgnore) as Record<string, unknown>;
    const type = msg.type as string | undefined;

    if (type === 'system' && msg.subtype === 'init') {
      if (!sessionStartedEmitted) {
        events.push({ type: 'session_start' });
        hookOrder.push('session_start');
        sessionStartedEmitted = true;
      }
      continue;
    }

    if (type === 'assistant') {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as unknown[] | undefined;
      // Capture per-turn usage from the assistant message — NOT the SDK's
      // aggregated `result.usage`. The Anthropic SDK exposes a running total
      // on `result.usage`, but the OR SDK's `stream_complete` reports only
      // the LAST turn's usage. Reading per-turn usage off each assistant and
      // keeping the latest gives both sides "final turn tokens", which is
      // the parity claim the comparator's exact-mode token check can actually
      // assert. See `canonicalizeOr` for the symmetric note.
      const turnUsage = message?.usage as Record<string, unknown> | undefined;
      if (turnUsage) {
        tokenUsage = anthropicUsageToCanon(turnUsage);
      }
      if (Array.isArray(content)) {
        // Turn boundary detection: the agent SDK FRAGMENTS one logical turn
        // across multiple `assistant` messages (e.g. one for text, a second
        // for `tool_use`). A new turn only starts when the SDK injects a
        // `user` (tool_result) message between assistants. So: only open a
        // turn bracket if none is currently open — re-using an open bracket
        // keeps fragmented turn content under a single canonical turn.
        if (!turnOpen) {
          const turnNumber = events.filter((e) => e.type === 'turn_start').length;
          events.push({ type: 'turn_start', turnNumber });
          hookOrder.push('turn_start');
          turnOpen = true;
        }
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
            events.push({ type: 'text', text: b.text });
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            const args = stripIds(b.input, extraIgnore);
            const canonName = stripMcpPrefix(b.name);
            events.push({ type: 'tool_call', name: canonName, args });
            toolCalls.push({ name: canonName, args });
            hookOrder.push(`tool_call:${canonName}`);
          }
        }
        // Bracket stays OPEN — the matching `turn_end` is emitted at the
        // next user (tool_result) message or at the terminal `result`.
      }
      continue;
    }

    if (type === 'user') {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as unknown[] | undefined;
      // Close the open turn BEFORE emitting tool_result events. This puts
      // the bracket boundary between the assistant's tool_use and the
      // user's tool_result — matching the OR side's structural ordering.
      closeTurn();
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result') {
            const isError = b.is_error === true;
            events.push({ type: 'tool_result', isError });
            hookOrder.push('tool_result');
          }
        }
      }
      continue;
    }

    // Phase 6.5b: project `stream_event` (partial-message) deltas the SAME
    // way OR's per-chunk `text_delta` projects — open a bracket on first
    // content delta, emit one `text` per content_block_delta, no hookOrder
    // push for individual deltas (matches OR's text_delta projection which
    // doesn't push hookOrder either). Without this projection, cancellation
    // scenarios with `includePartialMessages: true` would emit only
    // [session_start] on the Anthropic side while OR emits a full
    // [session_start, turn_start, ..., turn_end, terminal:error] sequence
    // — the comparator's exact hookOrder check can't pass on that asymmetry.
    // Non-cancellation scenarios don't enable partial messages, so this path
    // is a no-op for the happy-path scenarios #1-#5/#7/#8.
    if (type === 'stream_event') {
      const event = msg.event as Record<string, unknown> | undefined;
      const eventType = event?.type as string | undefined;
      if (eventType === 'content_block_delta') {
        const delta = event!.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (!turnOpen) {
            const turnNumber = events.filter((e) => e.type === 'turn_start').length;
            events.push({ type: 'turn_start', turnNumber });
            hookOrder.push('turn_start');
            turnOpen = true;
          }
          textParts.push(delta.text);
          events.push({ type: 'text', text: delta.text });
        }
      }
      continue;
    }

    if (type === 'result') {
      closeTurn();
      const subtype = (msg.subtype as string | undefined) ?? 'success';
      // Prefer per-turn usage collected from assistant messages (last
      // assistant wins) over `result.usage` (cumulative). The OR side
      // reports last-turn-only on its terminal; matching at last-turn
      // granularity is the only way the exact-mode token check passes for
      // multi-turn scenarios without diverging SDK accounting semantics.
      // Fallback to `result.usage` ONLY when no assistant message carried
      // per-turn usage (synthetic test fixtures that don't model the SDK's
      // real shape, or single-turn no-tool runs that didn't expose per-turn).
      if (tokenUsage.input === 0 && tokenUsage.output === 0) {
        const usage = (msg.usage as Record<string, unknown> | undefined) ?? undefined;
        if (usage) {
          tokenUsage = anthropicUsageToCanon(usage);
        }
      }
      terminalStatus = subtype;
      events.push({ type: 'terminal', status: subtype, usage: tokenUsage });
      hookOrder.push(`terminal:${subtype}`);
      continue;
    }

    // Other message types (`stream_event`, `partial_assistant`, hook
    // lifecycle, compact-boundary, status, rate-limit, …) deliberately
    // skipped — they don't have an OR counterpart in v1 and projecting
    // them would force divergence on lifecycle noise the comparator
    // can't actually assert against.
  }

  // Defensive: if the transcript ended without a `result` message (SDK
  // threw mid-stream, or some other partial-capture path), still close any
  // open turn so the projection's event count is well-formed for the
  // comparator.
  closeTurn();

  // Phase 6.5b: when the SDK threw (cancellation) and no `result` message
  // arrived, synthesize a terminal:aborted event so the canonical stream
  // ends with a terminal entry. The OR side emits `terminal:error` from its
  // `stream_complete` event on abort; we project both to `terminal:aborted`
  // for parity (see `canonicalizeOr` below for the matching map).
  if (transcript.thrown && terminalStatus === null) {
    terminalStatus = 'aborted';
    events.push({ type: 'terminal', status: 'aborted', usage: tokenUsage });
    hookOrder.push('terminal:aborted');
  }

  return {
    events,
    finalText: textParts.join(''),
    toolCalls,
    tokenUsage,
    terminalStatus,
    hookOrder,
    thrown: transcript.thrown,
  };
}

// ----- Helpers -----

/**
 * Deep-clone the input while stripping any string-valued key matching the
 * `toolu_*` / `call_*` / `id` patterns, and masking any key listed in
 * `extraIgnore`. Pure — never mutates input.
 *
 * Why strip IDs unconditionally: tool-use IDs are SDK-generated and never
 * align between Anthropic and OR. Comparing them would force every scenario
 * to mask them per-test. Strip once, here.
 */
function stripIds(value: unknown, extraIgnore: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => stripIds(v, extraIgnore));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (extraIgnore.has(k)) {
        out[k] = '<masked>';
        continue;
      }
      if ((k === 'id' || k === 'tool_use_id' || k === 'callId') && typeof v === 'string') {
        out[k] = '<stripped-id>';
        continue;
      }
      out[k] = stripIds(v, extraIgnore);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Strip inline tool-use IDs that show up embedded in other strings.
    return value
      .replace(/\btoolu_[A-Za-z0-9_-]+/g, '<toolu>')
      .replace(/\bcall_[A-Za-z0-9_-]+/g, '<call>');
  }
  return value;
}

function orUsageToCanon(usage: unknown): { input: number; output: number } {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
  const u = usage as Record<string, unknown>;
  // OR's `Usage` exposes `inputTokens` / `outputTokens`. Some surfaces also
  // carry the underlying provider fields (`prompt_tokens`/`completion_tokens`
  // from OpenAI-style; `input_tokens`/`output_tokens` from Anthropic-style).
  // Accept any of the three to keep the projector tolerant of upstream
  // shape changes — the parity claim doesn't hinge on which field name won.
  const input = pickNumber(u, ['inputTokens', 'input_tokens', 'prompt_tokens']) ?? 0;
  const output = pickNumber(u, ['outputTokens', 'output_tokens', 'completion_tokens']) ?? 0;
  return { input, output };
}

function anthropicUsageToCanon(usage: Record<string, unknown>): {
  input: number;
  output: number;
} {
  const input = pickNumber(usage, ['input_tokens', 'inputTokens']) ?? 0;
  const output = pickNumber(usage, ['output_tokens', 'outputTokens']) ?? 0;
  return { input, output };
}

/**
 * Strip the `mcp__<server>__` prefix from a tool name. The Anthropic agent
 * SDK wraps SDK-defined tools in MCP server semantics; the wire name is
 * `mcp__harness__echo` while the OR side sees the bare `echo`. The comparator
 * compares semantic tool calls, so the projection layer normalizes both to
 * the bare name. (See `scenarios/_tools.ts` for where the prefix comes from
 * and why it can't be elided at the SDK layer.) No-op on already-bare names.
 */
function stripMcpPrefix(name: string): string {
  const match = /^mcp__[A-Za-z0-9_-]+__(.+)$/.exec(name);
  return match ? match[1]! : name;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
