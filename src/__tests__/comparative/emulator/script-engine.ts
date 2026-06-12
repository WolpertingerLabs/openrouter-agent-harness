// Script-execution engine for the comparative-parity emulator. Shared between
// the Anthropic adapter (Card 6.1) and the OpenAI/OR adapter (Card 6.2).
//
// Scripts are indexed by `{ promptHash, turn }`. `promptHash` is the SHA-256
// of the request body after stripping non-semantic fields. `turn` is a counter
// the emulator maintains per session — incremented on every successful match.
//
// A missing script entry is a HARD 500 with a structured diagnostic dump.
// Silent fallthrough is what makes mock-based tests rot.
//
// 6.2 adds a `wire: 'anthropic' | 'openai'` discriminator on every entry. The
// adapter infers the wire from the request URL path; the script's `wire` field
// MUST match or lookup returns a wire-mismatch error (same diagnostic shape as
// a miss). Entries without `wire` default to 'anthropic' so 6.1 scripts and
// tests continue to type-check and behave identically.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type WireFormat = 'anthropic' | 'openai' | 'openresponses';

export type AnthropicStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn';

export type AnthropicTextBlock = { type: 'text'; text: string };
export type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export type AnthropicResponse = {
  id?: string;
  model: string;
  stopReason: AnthropicStopReason;
  stopSequence?: string | null;
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
};

// ----- OpenAI / OpenRouter chat-completions response shape -----

export type OpenAIFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export type OpenAIToolCall = {
  id: string;
  name: string;
  // Arguments serialized to a JSON string. Streamed as incremental
  // string-concat in `delta.tool_calls[i].function.arguments`.
  arguments: string;
};

export type OpenAIResponse = {
  id?: string;
  model: string;
  finishReason: OpenAIFinishReason;
  // Plain assistant text content. Omit or set to '' when emitting tool_calls
  // only. Streamed via `delta.content`.
  content?: string;
  // Each entry streams as one or more `delta.tool_calls` chunks. Args text
  // is chunked according to `StreamControl.chunkSize`.
  toolCalls?: OpenAIToolCall[];
  // Optional `delta.reasoning` text streamed before content. Stub-only
  // wiring per ambiguity call #3 — only emitted if a script supplies it.
  reasoning?: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type StreamControl = {
  chunkSize?: 'natural' | number;
  interChunkDelayMs?: number;
};

export type AnthropicFailureMode =
  | {
      type: 'mid_stream_error';
      // Deliver this many normal events before emitting an Anthropic
      // `error` event and closing the connection.
      eventsBeforeError: number;
      error?: { type: string; message: string };
    }
  | {
      type: 'rate_limit_429';
      retryAfter: string | number;
    }
  | {
      type: 'malformed_delta';
      // Inject malformed JSON in the Nth `content_block_delta` (0-indexed).
      atDeltaIndex: number;
    }
  | {
      type: 'truncated_stream';
      // Deliver this many normal events, then close the socket mid-event
      // (no terminating `\n\n`).
      eventsBeforeTruncation: number;
    }
  | {
      type: 'split_json_field';
      // Force a TCP chunk boundary in the middle of a `data:` line so the
      // SDK's incremental parser must reassemble across chunks.
      atDeltaIndex: number;
      splitAt: number;
    };

// Re-exported under the legacy name so 6.1 tests keep compiling.
export type FailureMode = AnthropicFailureMode;

export type OpenAIFailureMode =
  | {
      type: 'mid_stream_error';
      // Deliver this many normal chat.completion.chunk events, then write an
      // OpenAI-shape error chunk and close the connection. Distinct from the
      // upstream-5xx path (use HTTP status injection for that — not yet wired
      // because no scenario needs it; mid-stream after 200 is what the SDK
      // actually has to survive).
      eventsBeforeError: number;
      error?: { type: string; message: string; code?: string };
    }
  | {
      type: 'rate_limit_429';
      retryAfter: string | number;
    }
  | {
      type: 'malformed_chunk';
      // Inject malformed JSON in the Nth `data:` chunk (0-indexed, counting
      // only content/tool-call delta chunks — not the implicit role-only
      // first chunk).
      atChunkIndex: number;
    }
  | {
      type: 'truncated_stream';
      // Deliver N chunks, then close the socket mid-chunk (no `\n\n`
      // terminator and no `data: [DONE]`).
      eventsBeforeTruncation: number;
    }
  | {
      type: 'split_json_field';
      // Force a TCP chunk boundary inside the Nth chunk's data line so the
      // SDK's incremental parser must reassemble across reads.
      atChunkIndex: number;
      splitAt: number;
    }
  | {
      type: 'tool_call_args_malformed';
      // Replace the tool-call args streamed JSON with an invalid token (e.g.
      // `{"bad":` with no close). Exercises the SDK's args-parsing fallback.
      // The script must declare a `toolCalls` entry; the args of the Nth
      // tool call (0-indexed) get the malformed override.
      toolCallIndex: number;
    };

export type SuccessOutcome = {
  kind: 'success';
  response: AnthropicResponse;
  stream?: StreamControl;
};

export type FailureOutcome = {
  kind: 'failure';
  failure: AnthropicFailureMode;
  // For failure modes that need a partial stream, the script may carry a
  // response whose initial events are replayed up to the failure point.
  partial?: AnthropicResponse;
  stream?: StreamControl;
};

export type ScriptOutcome = SuccessOutcome | FailureOutcome;

type AnthropicScriptEntryBase = {
  promptHash: string;
  turn: number;
  // `wire` defaults to 'anthropic' when absent — preserves the 6.1 entry
  // shape verbatim. The adapter sees this default during wire-match.
  wire?: 'anthropic';
};

type OpenAISuccessOutcome = {
  kind: 'success';
  response: OpenAIResponse;
  stream?: StreamControl;
};

type OpenAIFailureOutcome = {
  kind: 'failure';
  failure: OpenAIFailureMode;
  partial?: OpenAIResponse;
  stream?: StreamControl;
};

type OpenAIScriptEntryBase = {
  promptHash: string;
  turn: number;
  wire: 'openai';
};

export type AnthropicScriptEntry = AnthropicScriptEntryBase & ScriptOutcome;
export type OpenAIScriptEntry = OpenAIScriptEntryBase &
  (OpenAISuccessOutcome | OpenAIFailureOutcome);

// ----- OpenRouter `/responses` (OpenResponses) wire (Phase 6.5a) -----
//
// The `@openrouter/agent` SDK posts to `/responses` (not `/v1/chat/completions`
// — that endpoint is owned by 6.2's wire and currently has no live consumer
// inside this repo's harness). We add a third wire to drive the OR-side of
// the comparative harness without forking the SDK or routing through a
// chat-compat layer that the agent SDK doesn't use in production.
//
// v1 scope (success-mode only) covers exactly what scenarios #1-#4 need:
//   - assistant text output
//   - tool-use calls (function_call output items)
//   - multi-turn continuation via `previous_response_id`
//
// Failure injection on this wire is deliberately deferred to 6.6 — the
// `/responses` event vocabulary differs significantly from chat-completions
// and the failure-injection design has to be re-thought per wire anyway.

export type OpenResponsesContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      callId: string;
      name: string;
      // Arguments serialized as a JSON string — matches the wire shape where
      // `response.function_call_arguments.delta` carries string fragments.
      arguments: string;
    };

export type OpenResponsesStatus = 'completed' | 'incomplete' | 'failed';

export type OpenResponsesResponse = {
  id?: string;
  model: string;
  status: OpenResponsesStatus;
  content: OpenResponsesContentBlock[];
  // Token accounting that lands on the terminal `response.completed` event's
  // OpenResponsesResult body. The OR SDK normalizes these into `inputTokens`
  // / `outputTokens` on its consumer-facing `Usage` shape.
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
};

type OpenResponsesScriptEntryBase = {
  promptHash: string;
  turn: number;
  wire: 'openresponses';
};

type OpenResponsesSuccessOutcome = {
  kind: 'success';
  response: OpenResponsesResponse;
  stream?: StreamControl;
};

// Phase 6.5c: minimal failure-mode set on the OpenResponses wire. v1 shipped
// only `rate_limit_429` (for scenario #12's retry-on-429 parity claim).
// Phase 6.6 extends with the four wire-level failure modes needed to exercise
// scenarios #13–#16's parity claim on the OR side: mid_stream_error,
// malformed_chunk, truncated_stream, split_json_field. The shapes are ported
// 1:1 from the OpenAI adapter's failure-mode set (openai.ts) so the per-wire
// surface stays uniform — only the event vocabulary differs at the byte level,
// which the openresponses adapter handles internally. Scope-deviation flagged
// in the 6.6 PR body: this is the smallest extension that lets the parity
// claim "both SDKs surface a typed error on a malformed stream" be asserted
// against the OR SDK's real /responses consumer, since the OR client doesn't
// route through chat-completions.
export type OpenResponsesFailureMode =
  | {
      type: 'rate_limit_429';
      retryAfter: string | number;
    }
  | {
      type: 'mid_stream_error';
      // Deliver this many normal SSE events before emitting an OpenResponses
      // `response.failed` event and closing the connection. The SDK surfaces
      // the failed-response payload as a typed error on its consumer stream.
      eventsBeforeError: number;
      error?: { type: string; message: string };
    }
  | {
      type: 'malformed_event';
      // Inject malformed JSON in the Nth delta-bearing event (0-indexed,
      // counting only `response.output_text.delta` /
      // `response.function_call_arguments.delta` events). Mirrors openai.ts's
      // `malformed_chunk` shape.
      atEventIndex: number;
    }
  | {
      type: 'truncated_stream';
      // Deliver this many normal events, then close the socket mid-event
      // (no terminating `\n\n` and no `data: [DONE]`).
      eventsBeforeTruncation: number;
    }
  | {
      type: 'split_json_field';
      // Force a TCP chunk boundary inside the Nth delta-bearing event's
      // `data:` line so the SDK's incremental parser must reassemble across
      // reads. Mirrors openai.ts's `split_json_field` shape.
      atEventIndex: number;
      splitAt: number;
    };

type OpenResponsesFailureOutcome = {
  kind: 'failure';
  failure: OpenResponsesFailureMode;
  // For failure modes that need a partial stream, the script may carry a
  // response whose initial events are replayed up to the failure point.
  // 429 doesn't use this (the handler short-circuits before any SSE bytes).
  partial?: OpenResponsesResponse;
  stream?: StreamControl;
};

export type OpenResponsesScriptEntry = OpenResponsesScriptEntryBase &
  (OpenResponsesSuccessOutcome | OpenResponsesFailureOutcome);

export type ScriptEntry = AnthropicScriptEntry | OpenAIScriptEntry | OpenResponsesScriptEntry;

export function entryWire(entry: ScriptEntry): WireFormat {
  return entry.wire ?? 'anthropic';
}

export function isAnthropicEntry(entry: ScriptEntry): entry is AnthropicScriptEntry {
  return entryWire(entry) === 'anthropic';
}

export function isOpenAIEntry(entry: ScriptEntry): entry is OpenAIScriptEntry {
  return entryWire(entry) === 'openai';
}

export function isOpenResponsesEntry(entry: ScriptEntry): entry is OpenResponsesScriptEntry {
  return entryWire(entry) === 'openresponses';
}

type DiagnosticEvent = {
  promptHash: string;
  turn: number;
  body: unknown;
  registered: Array<{ promptHash: string; turn: number; kind: ScriptOutcome['kind'] }>;
};

/**
 * Stable JSON serialization with sorted keys. Used to ensure that two
 * semantically-equal request bodies hash to the same value regardless of
 * the order the SDK happened to serialize fields in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Strip non-semantic fields from an Anthropic Messages API request body
 * before hashing. The fields we keep are the ones that meaningfully change
 * what the model would produce — model, messages, system, tools, tool_choice,
 * max_tokens, temperature, top_p, top_k, stop_sequences.
 *
 * Fields explicitly excluded: `metadata` (per-request identifiers),
 * `stream` (transport choice, not semantic), `anthropic_version` (header-level),
 * any `*_id` field, and unknown forward-compat fields.
 *
 * The `wire` argument selects between the Anthropic and OpenAI/OR shapes.
 * Defaults to 'anthropic' for back-compat with 6.1 callers.
 */
export function canonicalizeRequest(body: unknown, wire: WireFormat = 'anthropic'): string {
  if (body === null || typeof body !== 'object') {
    return stableStringify({ raw: body });
  }
  const b = body as Record<string, unknown>;
  if (wire === 'openresponses') {
    // OpenRouter `/responses` (OpenResponses) shape. Fields kept are those
    // that meaningfully change what the model would produce:
    //   - `model`, `input` (the message list), `instructions` (system prompt)
    //   - `tools`, `tool_choice`
    //   - `previous_response_id` (multi-turn continuation chain)
    //   - sampling knobs (`temperature`, `top_p`, `max_output_tokens`)
    // Explicitly excluded: `stream` (transport), `store` (server-side
    // persistence flag), `session_id` (per-run identifier), `service_tier`
    // (transport preference), `metadata` / `user` / unknown forward-compat
    // fields. The hash deliberately does NOT include the `wire` token so the
    // wire-mismatch path stays reachable (same rationale as the openai wire).
    const canonical: Record<string, unknown> = {
      model: b.model ?? null,
      input: b.input ?? [],
      instructions: b.instructions ?? null,
      tools: b.tools ?? null,
      tool_choice: b.tool_choice ?? null,
      previous_response_id: b.previous_response_id ?? null,
      max_output_tokens: b.max_output_tokens ?? null,
      temperature: b.temperature ?? null,
      top_p: b.top_p ?? null,
      reasoning: b.reasoning ?? null,
      response_format: b.response_format ?? null,
    };
    return stableStringify(canonical);
  }
  if (wire === 'openai') {
    // OpenAI/OR-compatible chat-completions shape. Fields kept are the
    // ones that meaningfully shape the model's output. Excluded: `stream`
    // (transport), `metadata` / `user` (per-request identifiers), `n` (the
    // emulator only scripts single completions), and unknown forward-compat
    // fields. The hash deliberately does NOT include the `wire` token so the
    // wire-mismatch path is reachable: a body can hash-collide across both
    // adapters and the registry catches the wire mismatch explicitly.
    const canonical: Record<string, unknown> = {
      model: b.model ?? null,
      messages: b.messages ?? [],
      tools: b.tools ?? null,
      tool_choice: b.tool_choice ?? null,
      max_tokens: b.max_tokens ?? null,
      temperature: b.temperature ?? null,
      top_p: b.top_p ?? null,
      frequency_penalty: b.frequency_penalty ?? null,
      presence_penalty: b.presence_penalty ?? null,
      stop: b.stop ?? null,
      seed: b.seed ?? null,
      response_format: b.response_format ?? null,
    };
    return stableStringify(canonical);
  }
  const canonical: Record<string, unknown> = {
    model: b.model ?? null,
    // The Anthropic agent SDK injects three classes of nondeterministic
    // content into the request that have to be stripped before hashing or no
    // two captures of "the same scenario" will ever agree:
    //
    //   - **Billing-header system block** (`x-anthropic-billing-header:
    //     cc_version=...; cch=<content-hash>;`). The `cch` token is a
    //     content hash the SDK rotates on its own internal state — it
    //     changes between runs on the same machine, between SDK versions,
    //     and across users.
    //   - **`<system-reminder>` blocks** the SDK pastes into the first user
    //     message from `~/.claude/CLAUDE.md`, the project CLAUDE.md, the
    //     user's skills list, and the user-email/date context. Every one of
    //     these is per-developer-machine state that has nothing to do with
    //     the scenario's parity claim.
    //   - **Wall-clock month in tool descriptions** — the CLI's built-in
    //     `WebSearch` tool description embeds "The current month is <Month>
    //     <Year>", regenerated from the clock at spawn time. Masked via
    //     `maskAnthropicToolDescriptionMonth` so hashes survive month
    //     boundaries (the 2026-06-01 suite-wide breakage).
    //
    // Both get stripped here; the remaining `system` / `messages` content
    // (custom system prompt, the actual user prompt) is what the model would
    // semantically see. Filtering is conservative — anything that doesn't
    // match the known patterns is kept verbatim — so a scenario that needs
    // to assert on system-prompt content still can.
    system: stripAnthropicBillingHeader(b.system),
    messages: stripAnthropicSystemReminders(b.messages),
    tools: maskAnthropicToolDescriptionMonth(b.tools),
    tool_choice: b.tool_choice ?? null,
    max_tokens: b.max_tokens ?? null,
    temperature: b.temperature ?? null,
    top_p: b.top_p ?? null,
    top_k: b.top_k ?? null,
    stop_sequences: b.stop_sequences ?? null,
  };
  return stableStringify(canonical);
}

/**
 * Strip the `x-anthropic-billing-header: …` text block (and the SDK's
 * standard "You are a Claude agent…" preamble that always rides with it)
 * from an Anthropic system field. Returns the remaining blocks unchanged.
 *
 * The two stripped blocks are SDK-injected boilerplate that varies per run
 * (billing header) or per SDK version (preamble); filtering them here keeps
 * the hash stable across both axes.
 */
function stripAnthropicBillingHeader(system: unknown): unknown {
  if (!Array.isArray(system)) return system ?? null;
  return system.filter((block) => {
    if (!block || typeof block !== 'object') return true;
    const b = block as Record<string, unknown>;
    if (b.type !== 'text' || typeof b.text !== 'string') return true;
    if (b.text.startsWith('x-anthropic-billing-header:')) return false;
    if (b.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.") return false;
    return true;
  });
}

/**
 * Strip `<system-reminder>…</system-reminder>` blocks from any text content
 * inside an Anthropic `messages` array. These are per-machine context
 * blocks the SDK pastes in from CLAUDE.md / skills / user-context files.
 * They're not part of the scenario; keeping them would tie the hash to a
 * specific developer's local state.
 *
 * If a text block is ENTIRELY a system-reminder (no other content), the
 * block is dropped. Mixed content has just the `<system-reminder>...` spans
 * removed; surrounding text is preserved verbatim.
 */
function stripAnthropicSystemReminders(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages ?? [];
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const m = msg as Record<string, unknown>;
    if (!Array.isArray(m.content)) return msg;
    const filtered = m.content
      .map((block) => {
        if (!block || typeof block !== 'object') return block;
        const b = block as Record<string, unknown>;
        if (b.type !== 'text' || typeof b.text !== 'string') return block;
        const stripped = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
        if (stripped.trim() === '') return null;
        return { ...b, text: stripped };
      })
      .filter((b) => b !== null);
    return { ...m, content: filtered };
  });
}

/**
 * Token substituted for the wall-clock month/year the Claude CLI bakes into
 * its built-in `WebSearch` tool description ("The current month is June
 * 2026. You MUST use this year when searching…"). The sentence is generated
 * from the machine's clock at spawn time, so without masking every recorded
 * promptHash silently expires at the next month boundary — which is exactly
 * what broke the whole emulated suite on 2026-06-01 (recorded in May,
 * replayed in June; every request script-missed with a 500).
 *
 * Exported so re-recording tooling can reconstruct what an unmasked
 * canonical form would have hashed to for a given month.
 */
export const MASKED_CURRENT_MONTH = '<masked:current-month>';

/**
 * Matches the dynamic month sentence fragment inside a tool description.
 * Deliberately narrow: full English month name + 4-digit year immediately
 * following the literal "The current month is". Anything else in the
 * description is kept verbatim, consistent with the conservative filtering
 * posture documented on `canonicalizeRequest`.
 */
const CURRENT_MONTH_RE =
  /The current month is (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/g;

/**
 * Mask the wall-clock month sentence in Anthropic `tools[].description`
 * strings (see `MASKED_CURRENT_MONTH`). Only `description` is touched —
 * tool names and `input_schema` carry no clock-derived content. Non-array
 * input and non-object entries pass through unchanged, mirroring the other
 * strip helpers.
 */
function maskAnthropicToolDescriptionMonth(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools ?? null;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const t = tool as Record<string, unknown>;
    if (typeof t.description !== 'string') return tool;
    const masked = t.description.replace(CURRENT_MONTH_RE, MASKED_CURRENT_MONTH);
    return masked === t.description ? tool : { ...t, description: masked };
  });
}

export function computePromptHash(body: unknown, wire: WireFormat = 'anthropic'): string {
  const canonical = canonicalizeRequest(body, wire);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export type ScriptMissError = {
  status: 500;
  body: {
    error: {
      type: 'emulator_script_miss';
      message: string;
      diagnostic: DiagnosticEvent;
    };
  };
  diagnosticKey: string;
};

export type ScriptWireMismatchError = {
  status: 500;
  body: {
    error: {
      type: 'emulator_wire_mismatch';
      message: string;
      diagnostic: DiagnosticEvent & { expectedWire: WireFormat; entryWire: WireFormat };
    };
  };
  diagnosticKey: string;
};

/**
 * Per-emulator-instance script registry. One ScriptRegistry per test (or per
 * emulator instance). Turn counters are **per-promptHash** (Phase 6.5a):
 * the SDK fires multiple distinct request bodies in parallel (Anthropic's
 * title-generation request + the main-prompt request, for example), and
 * each one is its own "track" — turn 0 of track A and turn 0 of track B
 * are independent. Without per-hash counters the registry would advance
 * past turn 0 on the first match and miss the parallel request that
 * legitimately needed turn 0 too.
 *
 * Missing-script diagnostics are deduped by `{promptHash, turn}` so that the
 * SDK's 15-retry-on-500 loop doesn't spam the test output 15× with the same
 * miss — subsequent retries against the same miss get a thin "still-missing"
 * payload without the registered-scripts dump.
 */
export class ScriptRegistry {
  private readonly entries: ScriptEntry[] = [];
  /** Per-promptHash turn counter. Independent tracks per distinct request body. */
  private readonly turnByHash = new Map<string, number>();
  /** Aggregate turn count across all hashes — what `turnsServed` exposes. */
  private totalServed = 0;
  private readonly emittedMisses = new Set<string>();

  register(entry: ScriptEntry): void {
    this.entries.push(entry);
  }

  registerMany(entries: ScriptEntry[]): void {
    for (const e of entries) this.entries.push(e);
  }

  /**
   * Look up the script for a freshly-received request body. On hit, advances
   * the turn counter. On miss, returns a structured diagnostic; the second
   * and subsequent misses for the same `{promptHash, turn}` get the
   * `dedup: true` flag so callers can emit a thinner response.
   *
   * The `expectedWire` argument defaults to 'anthropic' so 6.1 callers
   * continue to work verbatim. When the matched entry's `wire` field
   * disagrees, the lookup fails with a `emulator_wire_mismatch` diagnostic
   * — same dedup semantics as a script miss — and does NOT advance the turn
   * counter (so a follow-up request with the right wire can still match).
   */
  lookup(
    body: unknown,
    expectedWire?: 'anthropic',
  ):
    | { ok: true; entry: AnthropicScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true };
  lookup(
    body: unknown,
    expectedWire: 'openai',
  ):
    | { ok: true; entry: OpenAIScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true };
  lookup(
    body: unknown,
    expectedWire: 'openresponses',
  ):
    | { ok: true; entry: OpenResponsesScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true };
  lookup(
    body: unknown,
    expectedWire: WireFormat = 'anthropic',
  ):
    | { ok: true; entry: ScriptEntry; turn: number }
    | { ok: false; error: ScriptMissError; dedup: boolean }
    | { ok: false; error: ScriptWireMismatchError; dedup: boolean; mismatch: true } {
    const promptHash = computePromptHash(body, expectedWire);
    const turn = this.turnByHash.get(promptHash) ?? 0;
    const hit = this.entries.find((e) => e.promptHash === promptHash && e.turn === turn);
    if (hit) {
      const hitWire = entryWire(hit);
      if (hitWire !== expectedWire) {
        const diagnosticKey = `${promptHash}@${turn}#wire`;
        const dedup = this.emittedMisses.has(diagnosticKey);
        this.emittedMisses.add(diagnosticKey);
        const diagnostic = {
          promptHash,
          turn,
          body,
          registered: this.entries.map((e) => ({
            promptHash: e.promptHash,
            turn: e.turn,
            kind: e.kind,
            wire: entryWire(e),
          })),
          expectedWire,
          entryWire: hitWire,
        };
        return {
          ok: false,
          mismatch: true,
          error: {
            status: 500,
            body: {
              error: {
                type: 'emulator_wire_mismatch',
                message: `Script entry for promptHash=${promptHash} turn=${turn} declares wire=${hitWire} but request arrived on the ${expectedWire} adapter.`,
                diagnostic,
              },
            },
            diagnosticKey,
          },
          dedup,
        };
      }
      this.turnByHash.set(promptHash, turn + 1);
      this.totalServed += 1;
      return { ok: true, entry: hit, turn };
    }
    const diagnosticKey = `${promptHash}@${turn}`;
    const dedup = this.emittedMisses.has(diagnosticKey);
    this.emittedMisses.add(diagnosticKey);
    const diagnostic: DiagnosticEvent = {
      promptHash,
      turn,
      body,
      registered: this.entries.map((e) => ({
        promptHash: e.promptHash,
        turn: e.turn,
        kind: e.kind,
      })),
    };
    if (!dedup && process.env.DEBUG_COMPARATIVE_HASH === '1') {
      writeDebugHashDump(promptHash, turn, body, expectedWire, this.entries);
    }
    return {
      ok: false,
      error: {
        status: 500,
        body: {
          error: {
            type: 'emulator_script_miss',
            message: `No script registered for promptHash=${promptHash} turn=${turn}. Registered: ${this.entries.length} entries.`,
            diagnostic,
          },
        },
        diagnosticKey,
      },
      dedup,
    };
  }

  /** Total turns served so far (sum across every promptHash track). */
  get turnsServed(): number {
    return this.totalServed;
  }

  /** Reset all per-hash turn counters (e.g. between scenarios within one emulator instance). */
  reset(): void {
    this.turnByHash.clear();
    this.totalServed = 0;
    this.emittedMisses.clear();
  }
}

// Debug helper guarded behind `DEBUG_COMPARATIVE_HASH=1`. Dumps the raw
// request body, the wire format, the computed hash, the canonical-form
// string, and the registered (hash, turn) catalog to
// `tmp/comparative-hash-dump/<promptHash>@<turn>.json` on each unique miss.
// Diagnostic-only; never committed enabled.
function writeDebugHashDump(
  promptHash: string,
  turn: number,
  body: unknown,
  wire: WireFormat,
  entries: ScriptEntry[],
): void {
  try {
    const dir = join(process.cwd(), 'tmp', 'comparative-hash-dump');
    mkdirSync(dir, { recursive: true });
    const safeHash = promptHash.replace(/[^a-zA-Z0-9]/g, '_');
    const file = join(dir, `${safeHash}_turn${turn}.json`);
    const canonical = canonicalizeRequest(body, wire);
    appendFileSync(
      file,
      JSON.stringify(
        {
          promptHash,
          turn,
          wire,
          rawBody: body,
          canonical,
          registered: entries.map((e) => ({
            promptHash: e.promptHash,
            turn: e.turn,
            wire: entryWire(e),
          })),
        },
        null,
        2,
      ) + '\n---\n',
    );
  } catch {
    // best-effort diagnostic; never throw from the registry path
  }
}
