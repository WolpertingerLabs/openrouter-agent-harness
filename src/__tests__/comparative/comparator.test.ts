// Unit tests for the Phase 6.4 comparator. These cover the comparator in
// isolation — the smoke scenario's end-to-end wiring lives in
// `comparator.smoke.test.ts` so the unit tests don't pay the harness
// boot/spawn cost.
//
// Test fixtures are minimal synthetic transcripts crafted by hand. We do
// NOT round-trip through the SDKs here — that's the harness's job.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compareTranscripts } from './comparator.js';
import type { AnthropicTranscript, OrTranscript } from './transcript.js';
import type { ComparatorConfig } from './scenarios.js';
import type { AgentCoreEvent } from '../../events.js';

// ----- Helpers -----

const dumpRoot = join(tmpdir(), `comparator-test-${process.pid}`);

function orTranscript(events: AgentCoreEvent[], thrown?: string): OrTranscript {
  return { wire: 'openrouter', events, ...(thrown !== undefined && { thrown }) };
}

function anthropicTranscript(
  messages: Array<Record<string, unknown>>,
  thrown?: string,
): AnthropicTranscript {
  return { wire: 'anthropic', messages, ...(thrown !== undefined && { thrown }) };
}

/** Build a minimal "pong" run shared by the identical-transcripts tests. */
function buildPongPair(): { anth: AnthropicTranscript; or: OrTranscript } {
  const anth = anthropicTranscript([
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'pong' }] },
    },
    { type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 1 } },
  ]);
  const or = orTranscript([
    { type: 'session_started', sessionId: 's' },
    { type: 'turn_start', turnNumber: 0 },
    { type: 'text_delta', content: 'pong' },
    {
      type: 'turn_end',
      turnNumber: 0,
      usage: { inputTokens: 4, outputTokens: 1 } as never,
      costUsd: 0,
    },
    {
      type: 'stream_complete',
      status: 'success',
      usage: { inputTokens: 4, outputTokens: 1 } as never,
      costUsd: 0,
    },
  ]);
  return { anth, or };
}

/** Project the OR transcript's events to look like Anthropic's bracket
 * shape: the Anthropic projector emits `turn_start` → text → `turn_end`
 * per assistant message AND `terminal` from `result`. The OR projector
 * emits `session_start` → `turn_start` → text → `turn_end` → `terminal`.
 * To keep tests identical, we wrap the OR build to drop or add the
 * `session_start` mirror as needed. */
function buildIdenticalPair(): { anth: AnthropicTranscript; or: OrTranscript } {
  // Both sides project to:
  //   session_start, turn_start(0), text(pong), turn_end, terminal(success)
  return buildPongPair();
}

const tolerantConfig: ComparatorConfig = {
  mode: 'tolerant',
  tokenTolerancePct: 15,
};

const exactConfig: ComparatorConfig = { mode: 'exact' };

beforeEach(async () => {
  await rm(dumpRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(dumpRoot, { recursive: true, force: true });
});

// ----- Identical transcripts pass in both modes -----

describe('compareTranscripts — identical transcripts', () => {
  it('passes in exact mode when both projections match', async () => {
    const { anth, or } = buildIdenticalPair();
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'identical-exact',
      failureDumpRoot: dumpRoot,
    });
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.firstDivergentIndex).toBe(-1);
    expect(result.report).toContain('**PASS**');
  });

  it('passes in tolerant mode when both projections match', async () => {
    const { anth, or } = buildIdenticalPair();
    const result = await compareTranscripts(anth, or, tolerantConfig, {
      scenarioName: 'identical-tolerant',
      failureDumpRoot: dumpRoot,
    });
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ----- Additive OR-only events are non-comparable -----
//
// `message_item_start` is a purely additive OR-side output-item boundary
// marker with no Anthropic counterpart (see src/events.ts). The comparator
// must project it away, not surface it as an `unknown_or_event` error —
// otherwise every scenario diverges at the first assistant item the moment
// the OR SDK starts emitting boundaries. Regression guard for the gate
// breakage introduced alongside the event.

describe('compareTranscripts — additive OR-only boundary events', () => {
  it('ignores message_item_start so the projection matches the Anthropic side', async () => {
    const { anth, or } = buildIdenticalPair();
    // Interleave boundary markers exactly where the SDK emits them: on each
    // output item's `response.output_item.added`, BEFORE that item's deltas.
    const withBoundaries = orTranscript([
      or.events[0]!, // session_started
      or.events[1]!, // turn_start
      {
        type: 'message_item_start',
        kind: 'message',
        itemId: 'item-0',
        outputIndex: 0,
        phase: 'final_answer',
      },
      ...or.events.slice(2),
    ]);

    const result = await compareTranscripts(anth, withBoundaries, exactConfig, {
      scenarioName: 'message-item-start-ignored',
      failureDumpRoot: dumpRoot,
    });

    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.report).not.toContain('unknown_or_event');
  });

  it('ignores a reasoning-kind boundary without opening a stray turn bracket', async () => {
    // A `reasoning` boundary projects no content. If it opened a synthesized
    // turn bracket, the bracket would never close and the event stream would
    // gain a spurious turn_start/turn_end pair.
    const { anth, or } = buildIdenticalPair();
    const withReasoningBoundary = orTranscript([
      or.events[0]!,
      or.events[1]!,
      { type: 'message_item_start', kind: 'reasoning', itemId: 'item-r' },
      ...or.events.slice(2),
    ]);

    const result = await compareTranscripts(anth, withReasoningBoundary, exactConfig, {
      scenarioName: 'message-item-start-reasoning',
      failureDumpRoot: dumpRoot,
    });

    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('still reports a genuinely unknown OR event as a loud divergence', async () => {
    // The `default` fallthrough must stay loud — dropping message_item_start
    // must not turn into "silently swallow anything we do not recognize".
    const { anth, or } = buildIdenticalPair();
    const withUnknown = orTranscript([
      or.events[0]!,
      or.events[1]!,
      { type: 'some_future_event' } as unknown as AgentCoreEvent,
      ...or.events.slice(2),
    ]);

    const result = await compareTranscripts(anth, withUnknown, exactConfig, {
      scenarioName: 'unknown-or-event-still-loud',
      failureDumpRoot: dumpRoot,
    });

    expect(result.pass).toBe(false);
    expect(result.report).toContain('unknown_or_event:some_future_event');
  });
});

// ----- Divergence detection -----

describe('compareTranscripts — event-stream divergence', () => {
  it('detects an event-count mismatch and reports first divergent index', async () => {
    const { anth } = buildIdenticalPair();
    // OR side is missing the final terminal event.
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 4, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'event-count-mismatch',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'event_count')).toBe(true);
    // Anthropic has 5 events; OR has 4. First divergence is at index 4.
    expect(result.firstDivergentIndex).toBe(4);
  });

  it('detects an extra OR event and reports the first divergent index', async () => {
    const { anth } = buildIdenticalPair();
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      { type: 'text_delta', content: ' extra' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 4, outputTokens: 1 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 4, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'extra-or-event',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'event_count')).toBe(true);
    // event[3] is `turn_end` on Anthropic but `text(' extra')` on OR.
    expect(result.firstDivergentIndex).toBe(3);
  });

  it('detects tool-call args divergence in exact mode', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'echo',
              input: { text: 'hello' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }],
        },
      },
      { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'tool_call', callId: 'c1', name: 'echo', input: { text: 'goodbye' } },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'tool_result', callId: 'c1', output: 'ok', isError: false },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 10, outputTokens: 5 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'tool-args-divergence',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'tool_call_args')).toBe(true);
  });

  it('detects token-count divergence in exact mode', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 1 } },
    ]);
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 99, outputTokens: 88 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 99, outputTokens: 88 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'token-divergence',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'token_usage')).toBe(true);
  });
});

// ----- Tolerant mode token bands -----

describe('compareTranscripts — tolerant token bands', () => {
  it('passes inside the band', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 100 } },
    ]);
    // OR is 110/110 — within 15% band (allowed delta 15).
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 110, outputTokens: 110 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 110, outputTokens: 110 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(
      anth,
      or,
      { mode: 'tolerant', tokenTolerancePct: 15 },
      { scenarioName: 'tolerant-in-band', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(true);
  });

  it('fails outside the band', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 100 } },
    ]);
    // OR is 200/200 — 100% over, well outside 15% band.
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 200, outputTokens: 200 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 200, outputTokens: 200 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(
      anth,
      or,
      { mode: 'tolerant', tokenTolerancePct: 15 },
      { scenarioName: 'tolerant-out-band', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(false);
    expect(result.failures.filter((f) => f.kind === 'token_usage').length).toBeGreaterThan(0);
  });

  it('handles zero-reference token bands exactly', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'stream_complete', status: 'success', usage: null, costUsd: 0 },
    ]);
    const result = await compareTranscripts(
      anth,
      or,
      { mode: 'tolerant', tokenTolerancePct: 15 },
      { scenarioName: 'zero-band', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(true);
  });
});

// ----- Final-text predicates -----

describe('compareTranscripts — final-text predicates', () => {
  function pair(text: string): { anth: AnthropicTranscript; or: OrTranscript } {
    return {
      anth: anthropicTranscript([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'text', text }] } },
        { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
      or: orTranscript([
        { type: 'session_started', sessionId: 's' },
        { type: 'turn_start', turnNumber: 0 },
        { type: 'text_delta', content: text },
        {
          type: 'turn_end',
          turnNumber: 0,
          usage: { inputTokens: 1, outputTokens: 1 } as never,
          costUsd: 0,
        },
        {
          type: 'stream_complete',
          status: 'success',
          usage: { inputTokens: 1, outputTokens: 1 } as never,
          costUsd: 0,
        },
      ]),
    };
  }

  it('substring predicate — pass and fail', async () => {
    const { anth, or } = pair('the quick brown fox');
    const pass = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'substring', value: 'brown' },
      },
      { scenarioName: 'substring-pass', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(pass.pass).toBe(true);

    const fail = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'substring', value: 'purple' },
      },
      { scenarioName: 'substring-fail', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(fail.pass).toBe(false);
    expect(fail.failures.some((f) => f.kind === 'final_text')).toBe(true);
  });

  it('regex predicate — pass and fail', async () => {
    const { anth, or } = pair('error code 0x42 raised');
    const pass = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'regex', value: '0x[0-9a-f]+' },
      },
      { scenarioName: 'regex-pass', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(pass.pass).toBe(true);

    const fail = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'regex', value: '^success' },
      },
      { scenarioName: 'regex-fail', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(fail.pass).toBe(false);
  });

  it('lengthRange predicate — pass and fail', async () => {
    const { anth, or } = pair('hello world');
    const pass = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'lengthRange', min: 5, max: 20 },
      },
      { scenarioName: 'len-pass', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(pass.pass).toBe(true);

    const failMin = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'lengthRange', min: 100 },
      },
      { scenarioName: 'len-fail-min', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(failMin.pass).toBe(false);

    const failMax = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        finalTextAssertion: { type: 'lengthRange', max: 3 },
      },
      { scenarioName: 'len-fail-max', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(failMax.pass).toBe(false);
  });
});

// ----- Hook firing order assertion -----

describe('compareTranscripts — hook firing order', () => {
  it('fails in exact mode when hook order differs', async () => {
    // Anthropic: session_start → turn_start → text → turn_end → terminal.
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    // OR: missing session_started — hook order diverges from turn 0.
    const or = orTranscript([
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'a' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'hook-order-exact',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'hook_order')).toBe(true);
  });

  it('fails in tolerant mode too — hook order is EXACT in both modes', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const or = orTranscript([
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'a' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(
      anth,
      or,
      { mode: 'tolerant', tokenTolerancePct: 15 },
      { scenarioName: 'hook-order-tolerant', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'hook_order')).toBe(true);
  });
});

// ----- Per-arg tolerances -----

describe('compareTranscripts — per-arg tolerances', () => {
  function toolPair(
    anthInput: unknown,
    orInput: unknown,
  ): {
    anth: AnthropicTranscript;
    or: OrTranscript;
  } {
    return {
      anth: anthropicTranscript([
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'summarize', input: anthInput }],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }],
          },
        },
        { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } },
      ]),
      or: orTranscript([
        { type: 'session_started', sessionId: 's' },
        { type: 'turn_start', turnNumber: 0 },
        { type: 'tool_call', callId: 'c1', name: 'summarize', input: orInput },
        // Real OR SDK ordering: `turn_end` fires the moment the model's
        // SSE stream ends (i.e. right after the tool_use is emitted), and
        // `tool_result` lands OUTSIDE the model stream when the host
        // dispatches. The Anthropic projection's `closeTurn()` on the
        // `user` message mirrors this, so the canonical event order has
        // turn_end immediately after the tool_call and BEFORE tool_result.
        { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
        { type: 'tool_result', callId: 'c1', output: 'ok', isError: false },
        {
          type: 'stream_complete',
          status: 'success',
          usage: { inputTokens: 10, outputTokens: 5 } as never,
          costUsd: 0,
        },
      ]),
    };
  }

  it('accepts a per-arg substring tolerance for model-creative fields', async () => {
    const { anth, or } = toolPair(
      { topic: 'cats', summary: 'cats are independent and aloof' },
      { topic: 'cats', summary: 'felines are aloof creatures' },
    );
    const result = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        argTolerances: {
          'summarize.summary': { type: 'substring', value: 'aloof' },
        },
      },
      { scenarioName: 'arg-tol-substring', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(true);
  });

  it('still requires structural equality on unflagged fields', async () => {
    const { anth, or } = toolPair({ topic: 'cats' }, { topic: 'dogs' });
    const result = await compareTranscripts(
      anth,
      or,
      { mode: 'tolerant' },
      { scenarioName: 'arg-tol-unflagged', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'tool_call_args')).toBe(true);
  });

  it('numericDelta tolerance gates numeric proximity', async () => {
    const { anth, or } = toolPair({ score: 0.7 }, { score: 0.75 });
    const passResult = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        argTolerances: { 'summarize.score': { type: 'numericDelta', delta: 0.1 } },
      },
      { scenarioName: 'num-delta-pass', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(passResult.pass).toBe(true);

    const failResult = await compareTranscripts(
      anth,
      or,
      {
        mode: 'tolerant',
        argTolerances: { 'summarize.score': { type: 'numericDelta', delta: 0.01 } },
      },
      { scenarioName: 'num-delta-fail', failureDumpRoot: dumpRoot, dumpOnFail: false },
    );
    expect(failResult.pass).toBe(false);
  });
});

// ----- Terminal status -----

describe('compareTranscripts — terminal status', () => {
  it('fails when terminal status differs in exact mode', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'result', subtype: 'error_max_turns', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'text_delta', content: 'pong' },
      {
        type: 'turn_end',
        turnNumber: 0,
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'terminal-status',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.kind === 'terminal_status')).toBe(true);
  });
});

// ----- Thrown handling -----

describe('compareTranscripts — thrown handling', () => {
  it('surfaces both sides thrown without itself throwing', async () => {
    const anth = anthropicTranscript([], 'Anthropic boom');
    const or = orTranscript([], 'OR boom');
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'both-thrown',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    const thrown = result.failures.filter((f) => f.kind === 'thrown');
    expect(thrown).toHaveLength(2);
    expect(result.report).toContain('Anthropic boom');
    expect(result.report).toContain('OR boom');
  });
});

// ----- Failure dump -----

describe('compareTranscripts — failure dump', () => {
  it('writes report.md + transcript files to the configured dump root on fail', async () => {
    const anth = anthropicTranscript([], 'A');
    const or = orTranscript([], 'B');
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'dump-test',
      failureDumpRoot: dumpRoot,
    });
    expect(result.pass).toBe(false);
    expect(existsSync(dumpRoot)).toBe(true);
    const entries = await readdir(dumpRoot);
    expect(entries.length).toBeGreaterThan(0);
    const dir = join(dumpRoot, entries[0]!);
    const report = await readFile(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('# Comparator report: dump-test');
    const anthOnDisk = await readFile(join(dir, 'anthropic.transcript.json'), 'utf8');
    expect(JSON.parse(anthOnDisk).thrown).toBe('A');
  });

  it('skips the dump when dumpOnFail=false', async () => {
    const anth = anthropicTranscript([], 'A');
    const or = orTranscript([], 'B');
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'no-dump',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(false);
    expect(existsSync(dumpRoot)).toBe(false);
  });
});

// ----- Tool-use ID stripping -----

describe('compareTranscripts — ID stripping', () => {
  it('strips toolu_* / call_* IDs so they do not force divergence', async () => {
    const anth = anthropicTranscript([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_abc123', name: 'echo', input: { text: 'hi' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123', is_error: false }],
        },
      },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const or = orTranscript([
      { type: 'session_started', sessionId: 's' },
      { type: 'turn_start', turnNumber: 0 },
      { type: 'tool_call', callId: 'call_xyz999', name: 'echo', input: { text: 'hi' } },
      { type: 'turn_end', turnNumber: 0, usage: null, costUsd: 0 },
      { type: 'tool_result', callId: 'call_xyz999', output: 'ok', isError: false },
      {
        type: 'stream_complete',
        status: 'success',
        usage: { inputTokens: 1, outputTokens: 1 } as never,
        costUsd: 0,
      },
    ]);
    const result = await compareTranscripts(anth, or, exactConfig, {
      scenarioName: 'id-strip',
      failureDumpRoot: dumpRoot,
      dumpOnFail: false,
    });
    expect(result.pass).toBe(true);
  });
});
