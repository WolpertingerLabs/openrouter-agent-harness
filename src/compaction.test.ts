import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN,
  COMPACTION_FAILURE_LIMIT,
  COMPACTION_MIN_SHRINK_RATIO,
  COMPACTION_PROMPT,
  DEFAULT_PRUNE_PROTECTED_TOOLS,
  PRUNE_CLEARED_MARKER,
  PRUNE_MIN_RECLAIM_TOKENS,
  PRUNE_PROTECT_RECENT_TOKENS,
  PRUNE_PROTECT_RECENT_TURNS,
  PRUNE_REDERIVABLE_TOOLS,
  planToolOutputPrune,
  pruneStoredMarker,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_KEEP_BUDGET_MAX_TOKENS,
  DEFAULT_KEEP_BUDGET_MIN_TOKENS,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_SAFETY_BUFFER_TOKENS,
  DEFAULT_THRESHOLD_RATIO,
  KEEP_BUDGET_WINDOW_FRACTION,
  MAX_SUMMARIZER_TRIM_RETRIES,
  MODEL_CONTEXT_WINDOWS,
  SUMMARIZER_INPUT_RESERVE_TOKENS,
  SUMMARY_TOOL_OUTPUT_MAX_CHARS,
  estimateInstructionsAndToolsTokens,
  estimateMessagesCharLength,
  getModelContextWindow,
  isContextOverflowError,
  partitionMessages,
  renderMessagesForSummary,
  resolveCompactionThresholdChars,
  resolveCompactionThresholdTokens,
  resolveKeepBudgetTokens,
  resolveSummarizerInputBudgetChars,
  serializeMessagesForEstimate,
} from './compaction.js';

describe('COMPACTION_PROMPT', () => {
  it('is a non-empty stable string constant', () => {
    expect(typeof COMPACTION_PROMPT).toBe('string');
    expect(COMPACTION_PROMPT.length).toBeGreaterThan(50);
  });

  it('instructs the model to return only the summary text', () => {
    // Hard contract — downstream consumers (and the auto-compact integration
    // test) rely on the summary being un-prefaced so it can be embedded
    // verbatim into the rewritten developer-role message.
    expect(COMPACTION_PROMPT).toMatch(/Return only the summary/);
  });
});

describe('getModelContextWindow', () => {
  it('returns the exact-match window for a known model id', () => {
    expect(getModelContextWindow('anthropic/claude-sonnet-4.6')).toBe(200_000);
    expect(getModelContextWindow('openai/gpt-4.1')).toBe(1_000_000);
    expect(getModelContextWindow('google/gemini-2.5-pro')).toBe(1_000_000);
  });

  it("strips the leading '~' alias marker and re-tries", () => {
    expect(getModelContextWindow('~anthropic/claude-sonnet-latest')).toBe(
      MODEL_CONTEXT_WINDOWS['anthropic/claude-sonnet-latest'],
    );
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW_TOKENS for unknown models', () => {
    expect(getModelContextWindow('some-vendor/unknown-model-2099')).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("does not strip '~' twice for unknown stripped names", () => {
    // '~unknown/model' → 'unknown/model' is also unknown → fallback
    expect(getModelContextWindow('~unknown/model')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  describe('per-run overrides', () => {
    it('an override exact match beats the static table', () => {
      expect(
        getModelContextWindow('anthropic/claude-sonnet-4.6', {
          'anthropic/claude-sonnet-4.6': 1_000_000,
        }),
      ).toBe(1_000_000);
    });

    it("an override '~'-stripped alias match beats the static table's exact match", () => {
      // Full resolution order: override exact → override alias → static
      // exact → static alias → default. The override table only knows the
      // un-aliased id; the static table knows BOTH — the override alias
      // must still win.
      expect(
        getModelContextWindow('~anthropic/claude-sonnet-latest', {
          'anthropic/claude-sonnet-latest': 999,
        }),
      ).toBe(999);
    });

    it('an override exact match on an aliased id beats the override alias entry', () => {
      expect(
        getModelContextWindow('~anthropic/claude-sonnet-latest', {
          '~anthropic/claude-sonnet-latest': 111,
          'anthropic/claude-sonnet-latest': 222,
        }),
      ).toBe(111);
    });

    it('falls through to the static table when the overrides do not match', () => {
      expect(getModelContextWindow('anthropic/claude-sonnet-4.6', { 'other/model': 5 })).toBe(
        200_000,
      );
      expect(getModelContextWindow('~anthropic/claude-sonnet-latest', { 'other/model': 5 })).toBe(
        MODEL_CONTEXT_WINDOWS['anthropic/claude-sonnet-latest'],
      );
    });

    it('falls through overrides AND the static table to the default for unknown models', () => {
      expect(getModelContextWindow('new-vendor/new-model', { 'other/model': 5 })).toBe(
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      );
    });

    it('teaches the table about a model it does not know', () => {
      expect(
        getModelContextWindow('new-vendor/new-model', { 'new-vendor/new-model': 32_768 }),
      ).toBe(32_768);
    });
  });
});

describe('resolveCompactionThresholdChars', () => {
  it('returns the caller-supplied value verbatim when provided (raw chars)', () => {
    expect(resolveCompactionThresholdChars(12_345, 'anthropic/claude-sonnet-4.6')).toBe(12_345);
  });

  it('uses zero verbatim — does not treat 0 as "unset"', () => {
    // 0 is a legitimate override (force-trigger every turn). The function
    // distinguishes undefined from 0.
    expect(resolveCompactionThresholdChars(0, 'anthropic/claude-sonnet-4.6')).toBe(0);
  });

  it('derives the default threshold from the model context window when omitted', () => {
    const tokens = getModelContextWindow('anthropic/claude-sonnet-4.6');
    const expected = Math.floor(tokens * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO);
    expect(resolveCompactionThresholdChars(undefined, 'anthropic/claude-sonnet-4.6')).toBe(
      expected,
    );
  });

  it('falls back to the default window for unknown models', () => {
    const expected = Math.floor(
      DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO,
    );
    expect(resolveCompactionThresholdChars(undefined, 'unknown/whatever')).toBe(expected);
  });

  it('threads per-run window overrides into the derived default', () => {
    const expected = Math.floor(1_000 * CHARS_PER_TOKEN * DEFAULT_THRESHOLD_RATIO);
    expect(
      resolveCompactionThresholdChars(undefined, 'custom/model', { 'custom/model': 1_000 }),
    ).toBe(expected);
  });
});

describe('resolveCompactionThresholdTokens', () => {
  it('returns the caller-supplied value verbatim when provided (reinterpreted as tokens)', () => {
    expect(resolveCompactionThresholdTokens(50_000, 'anthropic/claude-sonnet-4.6')).toBe(50_000);
  });

  it('uses zero verbatim — does not treat 0 as "unset"', () => {
    expect(resolveCompactionThresholdTokens(0, 'anthropic/claude-sonnet-4.6')).toBe(0);
  });

  it('derives floor(window * ratio) with NO chars-per-token translation when omitted', () => {
    const tokens = getModelContextWindow('anthropic/claude-sonnet-4.6');
    expect(resolveCompactionThresholdTokens(undefined, 'anthropic/claude-sonnet-4.6')).toBe(
      Math.floor(tokens * DEFAULT_THRESHOLD_RATIO),
    );
  });

  it('threads per-run window overrides into the derived default', () => {
    expect(
      resolveCompactionThresholdTokens(undefined, 'custom/model', { 'custom/model': 10_000 }),
    ).toBe(Math.floor(10_000 * DEFAULT_THRESHOLD_RATIO));
  });

  describe('Phase 7.1 absolute-buffer shape (reserveOpts)', () => {
    it('subtracts the default reserve + buffer from the window when reserveOpts is passed', () => {
      const tokens = getModelContextWindow('anthropic/claude-sonnet-4.6'); // 200k
      expect(
        resolveCompactionThresholdTokens(undefined, 'anthropic/claude-sonnet-4.6', {}, {}),
      ).toBe(tokens - DEFAULT_OUTPUT_RESERVE_TOKENS - DEFAULT_SAFETY_BUFFER_TOKENS);
    });

    it('honours explicit reserve + buffer overrides', () => {
      expect(
        resolveCompactionThresholdTokens(
          undefined,
          'custom/m',
          { 'custom/m': 100_000 },
          {
            outputReserveTokens: 10_000,
            safetyBufferTokens: 5_000,
          },
        ),
      ).toBe(85_000);
    });

    it('floors at 25% of the window when reserve+buffer would go negative', () => {
      // 16k window, reserve(20k)+buffer(8k) → negative → floor(16k*0.25)=4000.
      expect(resolveCompactionThresholdTokens(undefined, 'tiny/m', { 'tiny/m': 16_000 }, {})).toBe(
        4_000,
      );
    });

    it('still honours an explicit configured threshold even when reserveOpts is passed', () => {
      expect(resolveCompactionThresholdTokens(12_345, 'anthropic/claude-sonnet-4.6', {}, {})).toBe(
        12_345,
      );
    });

    it('exposes sane default reserve / buffer constants', () => {
      expect(DEFAULT_OUTPUT_RESERVE_TOKENS).toBe(20_000);
      expect(DEFAULT_SAFETY_BUFFER_TOKENS).toBe(8_000);
    });
  });
});

describe('estimateInstructionsAndToolsTokens', () => {
  it('returns 0 when neither instructions nor tools are supplied', () => {
    expect(estimateInstructionsAndToolsTokens({})).toBe(0);
  });

  it('counts the instructions char length divided by CHARS_PER_TOKEN', () => {
    const instructions = 'x'.repeat(4 * CHARS_PER_TOKEN);
    expect(estimateInstructionsAndToolsTokens({ instructions })).toBe(4);
  });

  it('counts serialized tool schemas', () => {
    const tools = [{ name: 'read_file' }, { name: 'write_file' }];
    const chars = tools.reduce((acc, t) => acc + JSON.stringify(t).length, 0);
    expect(estimateInstructionsAndToolsTokens({ tools })).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });

  it('combines instructions + tools and rounds up', () => {
    const instructions = 'abc';
    const tools = [{ a: 1 }];
    const totalChars = 3 + JSON.stringify(tools[0]).length;
    expect(estimateInstructionsAndToolsTokens({ instructions, tools })).toBe(
      Math.ceil(totalChars / CHARS_PER_TOKEN),
    );
  });

  it('skips unserializable (cyclic) tool descriptors rather than throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;
    const tools = [{ name: 'ok' }, cyclic];
    const chars = JSON.stringify({ name: 'ok' }).length;
    expect(estimateInstructionsAndToolsTokens({ tools })).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });
});

describe('serializeMessagesForEstimate', () => {
  it('passes a string messages field through verbatim', () => {
    expect(serializeMessagesForEstimate('raw input')).toBe('raw input');
  });

  it("serializes the array form as each item's JSON, concatenated", () => {
    const items = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'bb' },
    ];
    expect(serializeMessagesForEstimate(items)).toBe(
      JSON.stringify(items[0]) + JSON.stringify(items[1]),
    );
  });

  it("returns '' for null / undefined / non-array / non-string", () => {
    expect(serializeMessagesForEstimate(null)).toBe('');
    expect(serializeMessagesForEstimate(undefined)).toBe('');
    expect(serializeMessagesForEstimate(42)).toBe('');
  });

  it('skips cyclic and undefined-serializing items rather than throwing', () => {
    const cyclic: Record<string, unknown> = { role: 'user' };
    cyclic.self = cyclic;
    // `undefined` array items JSON.stringify to the string 'null'; a bare
    // function serializes to undefined (not a string) and must be skipped.
    const items = [{ role: 'user', content: 'ok' }, cyclic, () => 'fn'];
    expect(serializeMessagesForEstimate(items)).toBe(JSON.stringify(items[0]));
  });

  it('estimateMessagesCharLength is exactly the serialized length (shared serialization)', () => {
    const items = [{ role: 'user', content: 'measure me' }];
    expect(estimateMessagesCharLength(items)).toBe(serializeMessagesForEstimate(items).length);
  });
});

describe('estimateMessagesCharLength', () => {
  it('returns the string length for a string input', () => {
    expect(estimateMessagesCharLength('hello world')).toBe(11);
  });

  it('returns 0 for null / undefined / non-array / non-string', () => {
    expect(estimateMessagesCharLength(null)).toBe(0);
    expect(estimateMessagesCharLength(undefined)).toBe(0);
    expect(estimateMessagesCharLength(42)).toBe(0);
    expect(estimateMessagesCharLength({ not: 'an array' })).toBe(0);
  });

  it('JSON-serializes each array item and sums the lengths', () => {
    const items = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'bb' },
    ];
    const expected = items.reduce((acc, item) => acc + JSON.stringify(item).length, 0);
    expect(estimateMessagesCharLength(items)).toBe(expected);
  });

  it('exercises the boundary: empty array returns exactly 0', () => {
    expect(estimateMessagesCharLength([])).toBe(0);
  });

  it('skips cyclic items rather than throwing', () => {
    const cyclic: Record<string, unknown> = { role: 'user' };
    cyclic.self = cyclic;
    const items = [{ role: 'user', content: 'ok' }, cyclic];
    // The cyclic item contributes 0; the leading item still counts.
    const expected = JSON.stringify(items[0]).length;
    expect(estimateMessagesCharLength(items)).toBe(expected);
  });
});

describe('partitionMessages', () => {
  it('returns empty summarize when the array is at or below keepRecentTurns', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, 5);
    expect(summarize).toEqual([]);
    expect(keep).toEqual(msgs);
  });

  it('splits the array at messages.length - keepRecentTurns', () => {
    const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const { summarize, keep } = partitionMessages(msgs, 2);
    expect(summarize).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(keep).toEqual([{ id: 4 }, { id: 5 }]);
  });

  it('treats keepRecentTurns=0 as "keep nothing"', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, 0);
    expect(summarize).toEqual(msgs);
    expect(keep).toEqual([]);
  });

  it('clamps negative keepRecentTurns to 0', () => {
    const msgs = [{ id: 1 }, { id: 2 }];
    const { summarize, keep } = partitionMessages(msgs, -3);
    expect(summarize).toEqual(msgs);
    expect(keep).toEqual([]);
  });

  it('uses the documented default when wired through', () => {
    // Spot-check that the default constant lines up with the issue spec.
    expect(DEFAULT_KEEP_RECENT_TURNS).toBe(5);
  });
});

// ——— Phase 7.2: turn-boundary-safe partition + token-budgeted keep tail ———

/** Item builders matching the SDK `InputsUnion` shapes the partition inspects. */
const u = (content = 'user-msg') => ({ type: 'message', role: 'user', content });
const uBare = (content = 'user-msg') => ({ role: 'user', content }); // legacy persisted shape
const a = (content = 'assistant-msg') => ({ type: 'message', role: 'assistant', content });
const fc = (content = '{}') => ({
  type: 'function_call',
  call_id: 'c1',
  name: 'read_file',
  arguments: content,
});
const fco = (content = 'output') => ({
  type: 'function_call_output',
  call_id: 'c1',
  output: content,
});
const r = (content = 'thinking') => ({ type: 'reasoning', summary: content });

/** Mirror of the partition's per-item estimate, for sizing test budgets. */
const itemTokens = (item: unknown) => Math.ceil(JSON.stringify(item).length / CHARS_PER_TOKEN);
const tokensOf = (items: unknown[]) => items.reduce<number>((acc, m) => acc + itemTokens(m), 0);

describe('partitionMessages — turn-granular keepRecentTurns (7.2)', () => {
  it('keeps the last N TURNS, cutting at a user message', () => {
    const msgs = [u('1'), a('1'), u('2'), a('2'), u('3'), a('3')];
    const { summarize, keep } = partitionMessages(msgs, 2);
    expect(summarize).toEqual([u('1'), a('1')]);
    expect(keep).toEqual([u('2'), a('2'), u('3'), a('3')]);
  });

  it('accepts the options-object form for the same turn override', () => {
    const msgs = [u('1'), a('1'), u('2'), a('2')];
    const { keep } = partitionMessages(msgs, { keepRecentTurns: 1 });
    expect(keep).toEqual([u('2'), a('2')]);
  });

  it('keeps everything when fewer turns exist than requested', () => {
    const msgs = [u('1'), a('1'), fc(), fco()];
    const { summarize, keep } = partitionMessages(msgs, 3);
    expect(summarize).toEqual([]);
    expect(keep).toEqual(msgs);
  });

  it('summarizes the pre-first-user preamble (developer/system items)', () => {
    const dev = { type: 'message', role: 'developer', content: '[old summary]' };
    const msgs = [dev, u('1'), a('1')];
    const { summarize, keep } = partitionMessages(msgs, 1);
    expect(summarize).toEqual([dev]);
    expect(keep).toEqual([u('1'), a('1')]);
  });

  it('keeps whole turns including tool calls/outputs/reasoning inside the turn', () => {
    const msgs = [u('1'), a('1'), u('2'), r(), fc(), fco(), a('2')];
    const { keep } = partitionMessages(msgs, 1);
    expect(keep).toEqual([u('2'), r(), fc(), fco(), a('2')]);
  });

  it('recognizes the bare {role, content} user shape as a turn boundary', () => {
    const msgs = [uBare('1'), a('1'), uBare('2'), a('2')];
    const { keep } = partitionMessages(msgs, 1);
    expect(keep).toEqual([uBare('2'), a('2')]);
  });

  it('does NOT treat a user-role item with a non-message type as a turn boundary', () => {
    const odd = { type: 'function_call_output', role: 'user', call_id: 'c9', output: 'x' };
    const msgs = [u('1'), a('1'), odd, a('2')];
    // Only ONE real turn exists — `odd` is not a boundary, so keeping 1 turn
    // keeps everything from the sole user message.
    const { summarize, keep } = partitionMessages(msgs, 1);
    expect(summarize).toEqual([]);
    expect(keep).toEqual(msgs);
  });

  it('no-user-message history: falls back to trailing-N items snapped past an orphaned output', () => {
    const msgs = [a('1'), fc(), fco(), a('2')];
    // Trailing 2 would start at the fco — advance to the assistant message.
    const { keep } = partitionMessages(msgs, 2);
    expect(keep).toEqual([a('2')]);
  });
});

describe('partitionMessages — token-budgeted keep tail (7.2 default mode)', () => {
  it('keeps whole recent turns while the budget holds', () => {
    const turn1 = [u('x'.repeat(400)), a('y'.repeat(400))];
    const turn2 = [u('z'.repeat(400)), a('w'.repeat(400))];
    const msgs = [...turn1, ...turn2];
    // Budget fits turn2 exactly but not turn1 + turn2.
    const budget = tokensOf(turn2);
    const { summarize, keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(summarize).toEqual(turn1);
    expect(keep).toEqual(turn2);
  });

  it('keeps multiple turns when they all fit', () => {
    const msgs = [u('1'), a('1'), u('2'), a('2')];
    const { summarize, keep } = partitionMessages(msgs, { keepBudgetTokens: 8_000 });
    expect(summarize).toEqual([]);
    expect(keep).toEqual(msgs);
  });

  it('oversized single turn: falls back to the most recent complete group, never an orphaned output', () => {
    const big = u('x'.repeat(10_000));
    const tail = [fc('{"path":"a"}'), fco('small-output'), a('done')];
    const msgs = [big, ...tail];
    // Budget fits the tool-call group but not the giant user message.
    const budget = tokensOf(tail);
    const { summarize, keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(summarize).toEqual([big]);
    expect(keep).toEqual(tail);
    expect((keep[0] as { type?: string }).type).not.toBe('function_call_output');
  });

  it('oversized turn landing on a function_call_output advances past it', () => {
    const msgs = [u('x'.repeat(10_000)), fc('y'.repeat(10_000)), fco('out'), a('done')];
    // Budget fits [fco, a] but not the giant fc — the tentative cut lands on
    // the orphaned output and must advance to the assistant message.
    const budget = tokensOf([fco('out'), a('done')]);
    const { keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(keep).toEqual([a('done')]);
  });

  it('never keeps an unanchored trailing reasoning item', () => {
    const msgs = [u('x'.repeat(10_000)), a('y'.repeat(10_000)), r('brief')];
    // Budget fits only the trailing reasoning item — which anchors to
    // nothing. The tail collapses to empty rather than keeping it.
    const budget = itemTokens(r('brief'));
    const { summarize, keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(keep).toEqual([]);
    expect(summarize).toEqual(msgs);
  });

  it('allows the tail to start at an ANCHORED reasoning item', () => {
    const group = [r('why'), fc('{}'), fco('out'), a('done')];
    const msgs = [u('x'.repeat(10_000)), ...group];
    const budget = tokensOf(group);
    const { keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(keep).toEqual(group);
  });

  it('no user messages at all: splitTurn walk over the whole array', () => {
    const msgs = [a('x'.repeat(4_000)), a('tail-1'), a('tail-2')];
    const budget = tokensOf([a('tail-1'), a('tail-2')]);
    const { summarize, keep } = partitionMessages(msgs, { keepBudgetTokens: budget });
    expect(summarize).toEqual([a('x'.repeat(4_000))]);
    expect(keep).toEqual([a('tail-1'), a('tail-2')]);
  });

  it('derives the default budget from contextWindowTokens', () => {
    // 16k window → floor(16k * 0.25) = 4000-token budget. Two ~3000-token
    // turns: only the most recent fits.
    const turn1 = [u('x'.repeat(11_000)), a('y')];
    const turn2 = [u('z'.repeat(11_000)), a('w')];
    const msgs = [...turn1, ...turn2];
    const { keep } = partitionMessages(msgs, { contextWindowTokens: 16_000 });
    expect(keep).toEqual(turn2);
  });

  it('handles the empty array', () => {
    const { summarize, keep } = partitionMessages([], {});
    expect(summarize).toEqual([]);
    expect(keep).toEqual([]);
  });
});

describe('resolveKeepBudgetTokens', () => {
  it('clamps to the 8k ceiling on large windows', () => {
    expect(resolveKeepBudgetTokens(200_000)).toBe(DEFAULT_KEEP_BUDGET_MAX_TOKENS);
    expect(resolveKeepBudgetTokens(1_000_000)).toBe(DEFAULT_KEEP_BUDGET_MAX_TOKENS);
  });

  it('takes 25% of mid-size windows', () => {
    expect(resolveKeepBudgetTokens(20_000)).toBe(5_000);
    expect(KEEP_BUDGET_WINDOW_FRACTION).toBe(0.25);
  });

  it('clamps to the 2k floor on tiny windows', () => {
    expect(resolveKeepBudgetTokens(4_000)).toBe(DEFAULT_KEEP_BUDGET_MIN_TOKENS);
    expect(resolveKeepBudgetTokens(100)).toBe(DEFAULT_KEEP_BUDGET_MIN_TOKENS);
  });

  it('defaults to the 128k-window fallback (→ 8k) when no window is supplied', () => {
    expect(resolveKeepBudgetTokens()).toBe(
      Math.min(
        DEFAULT_KEEP_BUDGET_MAX_TOKENS,
        Math.floor(DEFAULT_CONTEXT_WINDOW_TOKENS * KEEP_BUDGET_WINDOW_FRACTION),
      ),
    );
  });
});

describe('partitionMessages — tail-validity property (7.2)', () => {
  // Deterministic LCG so failures are reproducible without a seed printout.
  const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  };

  const KINDS = [u, uBare, a, fc, fco, r] as const;

  it('for arbitrary interleavings the keep tail never starts with an orphaned output or unanchored reasoning', () => {
    const rand = lcg(0xc0ffee);
    for (let trial = 0; trial < 250; trial++) {
      const len = 1 + Math.floor(rand() * 12);
      const msgs: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const make = KINDS[Math.floor(rand() * KINDS.length)]!;
        msgs.push(make('x'.repeat(1 + Math.floor(rand() * 400))));
      }
      const mode = rand();
      const opts =
        mode < 0.4
          ? { keepRecentTurns: Math.floor(rand() * 5) }
          : { keepBudgetTokens: 10 + Math.floor(rand() * 500) };
      const { summarize, keep } = partitionMessages(msgs, opts);

      // Partition is lossless and ordered.
      expect([...summarize, ...keep]).toEqual(msgs);

      // The validity invariant applies when a compaction would actually
      // rewrite state (something got summarized). An empty summarize means
      // compact() no-ops and the history is left untouched, so the existing
      // (possibly already-odd) head is not the partition's doing.
      if (summarize.length > 0 && keep.length > 0) {
        const head = keep[0] as { type?: string };
        expect(head.type).not.toBe('function_call_output');
        if (head.type === 'reasoning') {
          // A reasoning head must anchor to a following item.
          expect(keep.length).toBeGreaterThan(1);
        }
      }
    }
  });
});

// ——— Phase 7.3: summarizer resilience primitives ———

describe('isContextOverflowError', () => {
  it.each([
    'This input exceeds the maximum context length',
    'prompt is too long: 250000 tokens > 200000 maximum',
    'Request too large: too many tokens',
    'maximum context window exceeded',
    'context_length_exceeded',
    'Input is too large for this model',
    'HTTP 413 Payload Too Large',
  ])('classifies %j as overflow', (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
  });

  it.each([
    'rate limit exceeded',
    'invalid api key',
    'Internal server error',
    'network timeout',
    '',
  ])('does NOT classify %j as overflow', (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false);
  });

  it('accepts plain strings and message-carrying objects', () => {
    expect(isContextOverflowError('context length exceeded')).toBe(true);
    expect(isContextOverflowError({ message: 'prompt is too long' })).toBe(true);
  });

  it('returns false for shapeless values', () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(42)).toBe(false);
    expect(isContextOverflowError({})).toBe(false);
  });
});

describe('resolveSummarizerInputBudgetChars', () => {
  it('reserves SUMMARIZER_INPUT_RESERVE_TOKENS out of large windows', () => {
    // claude-sonnet-4.6 = 200k → (200k − 20k) tokens × 4 chars.
    expect(resolveSummarizerInputBudgetChars('anthropic/claude-sonnet-4.6')).toBe(
      (200_000 - SUMMARIZER_INPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN,
    );
  });

  it('floors tiny windows at 25% rather than going non-positive', () => {
    expect(resolveSummarizerInputBudgetChars('tiny/model', { 'tiny/model': 1_000 })).toBe(
      Math.floor(1_000 * 0.25) * CHARS_PER_TOKEN,
    );
  });

  it('exposes sane retry/breaker/shrink constants', () => {
    expect(MAX_SUMMARIZER_TRIM_RETRIES).toBe(3);
    expect(COMPACTION_FAILURE_LIMIT).toBe(3);
    expect(COMPACTION_MIN_SHRINK_RATIO).toBeLessThan(1);
    expect(COMPACTION_MIN_SHRINK_RATIO).toBeGreaterThan(0);
  });
});

describe('renderMessagesForSummary', () => {
  it('passes a string messages field through verbatim and returns "" for non-arrays', () => {
    expect(renderMessagesForSummary('raw')).toBe('raw');
    expect(renderMessagesForSummary(null)).toBe('');
    expect(renderMessagesForSummary(42)).toBe('');
  });

  it('renders role-labelled message lines', () => {
    const out = renderMessagesForSummary([
      { role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'world' },
    ]);
    expect(out).toBe('user: hello\nassistant: world');
  });

  it('renders content-block arrays, replacing images/documents with markers', () => {
    const out = renderMessagesForSummary([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_file', file_data: 'QkJC' },
        ],
      },
    ]);
    expect(out).toBe('user: look at this [image] [document]');
    expect(out).not.toContain('AAAA');
  });

  it('renders tool calls with truncated arguments and tool results truncated to the cap', () => {
    const bigOutput = 'y'.repeat(SUMMARY_TOOL_OUTPUT_MAX_CHARS + 500);
    const out = renderMessagesForSummary([
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'c1', output: bigOutput },
    ]);
    expect(out).toContain('[tool call] read_file({"path":"a.txt"})');
    expect(out).toContain('[tool result] ');
    expect(out).toContain('… [truncated 500 chars]');
    expect(out.length).toBeLessThan(bigOutput.length);
  });

  it('strips encrypted reasoning content entirely, keeping the readable summary', () => {
    const out = renderMessagesForSummary([
      {
        type: 'reasoning',
        encrypted_content: 'SECRET_BLOB_' + 'Z'.repeat(200),
        summary: [{ type: 'summary_text', text: 'thinking about the bug' }],
      },
    ]);
    expect(out).toBe('[reasoning] thinking about the bug');
    expect(out).not.toContain('SECRET_BLOB_');
    expect(out).not.toContain('encrypted_content');
  });

  it('renders a bare [reasoning] marker when no readable summary exists', () => {
    expect(renderMessagesForSummary([{ type: 'reasoning', encrypted_content: 'SECRET' }])).toBe(
      '[reasoning]',
    );
    expect(renderMessagesForSummary([{ type: 'reasoning', summary: 'short note' }])).toBe(
      '[reasoning] short note',
    );
  });

  it('renders unknown item shapes as JSON with encrypted_content removed', () => {
    const out = renderMessagesForSummary([
      { type: 'mystery_item', payload: 'visible', encrypted_content: 'SECRET' },
    ]);
    expect(out).toContain('mystery_item');
    expect(out).toContain('visible');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('encrypted_content');
  });

  it('tolerates primitives, null items, and unserializable members', () => {
    const cyclic: Record<string, unknown> = { type: 'mystery' };
    cyclic.self = cyclic;
    const out = renderMessagesForSummary(['loose string', null, 7, cyclic]);
    expect(out).toContain('loose string');
    expect(out).toContain('7');
    expect(out).toContain('[unserializable]');
  });

  it('renders non-string function_call arguments and non-string outputs via JSON', () => {
    const out = renderMessagesForSummary([
      { type: 'function_call', call_id: 'c1', name: 'edit_file', arguments: { a: 1 } },
      { type: 'function_call_output', call_id: 'c1', output: { ok: true } },
    ]);
    expect(out).toContain('edit_file({"a":1})');
    expect(out).toContain('[tool result] {"ok":true}');
  });
});

describe('renderMessagesForSummary — content edge shapes', () => {
  it('renders string blocks and typeless object blocks inside content arrays', () => {
    const out = renderMessagesForSummary([
      { role: 'user', content: ['loose block', { weird: 'shape' }, null, 5] },
    ]);
    expect(out).toBe('user: loose block {"weird":"shape"}');
  });

  it('renders non-array object content via JSON and null content as empty', () => {
    expect(renderMessagesForSummary([{ role: 'user', content: { nested: true } }])).toBe(
      'user: {"nested":true}',
    );
    expect(renderMessagesForSummary([{ role: 'user', content: null }])).toBe('user: ');
    expect(renderMessagesForSummary([{ role: 'user' }])).toBe('user: ');
  });
});

// ——— Phase 7.4: tool-output prune tier ———

const pu = (content = 'user-msg') => ({ type: 'message', role: 'user', content });
const pa = (content = 'assistant-msg') => ({ type: 'message', role: 'assistant', content });
const pfc = (callId: string, name: string) => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: '{}',
});
const pfco = (callId: string, output: unknown) => ({
  type: 'function_call_output',
  call_id: callId,
  output,
});

describe('planToolOutputPrune', () => {
  it('selects old tool outputs below both protections, resolving names via call_id', () => {
    const big = 'x'.repeat(4_000); // 1000 tokens
    const msgs = [
      pu('t1'),
      pfc('c1', 'read_file'),
      pfco('c1', big),
      pa('done-1'),
      pu('t2'),
      pa('done-2'),
      pu('t3'),
      pa('done-3'),
    ];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 2,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates).toEqual([
      { index: 2, callId: 'c1', toolName: 'read_file', output: big, outputTokens: 1_000 },
    ]);
    expect(plan.reclaimedTokens).toBe(1_000);
  });

  it('protects everything inside the most recent K turns', () => {
    const big = 'x'.repeat(4_000);
    const msgs = [pu('t1'), pa('a1'), pu('t2'), pfc('c1', 'read_file'), pfco('c1', big), pa('a2')];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 2,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates).toEqual([]);
  });

  it('protects the most recent N tokens of tool output, newest first, across the whole history', () => {
    const oldOut = 'o'.repeat(800); // 200 tokens
    const newOut = 'n'.repeat(200); // 50 tokens
    const msgs = [
      pu('t1'),
      pfc('c1', 'read_file'),
      pfco('c1', oldOut),
      pa('a1'),
      pfc('c2', 'read_file'),
      pfco('c2', newOut),
      pa('a2'),
      pu('t2'),
      pa('a3'),
    ];
    // Budget 50: the newest output consumes it exactly; the older one is fair game.
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 50,
      minReclaimTokens: 1,
    });
    expect(plan.candidates.map((c) => c.callId)).toEqual(['c1']);
    // Budget 251: both outputs fall inside the protected recency budget.
    const planAll = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 251,
      minReclaimTokens: 1,
    });
    expect(planAll.candidates).toEqual([]);
  });

  it('skips protected tools (skill by default; custom list honored)', () => {
    const big = 'x'.repeat(4_000);
    const msgs = [
      pu('t1'),
      pfc('c1', 'skill'),
      pfco('c1', big),
      pfc('c2', 'web_probe'),
      pfco('c2', big),
      pu('t2'),
      pa('a'),
    ];
    const defaults = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(defaults.candidates.map((c) => c.toolName)).toEqual(['web_probe']);

    const custom = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
      protectedTools: ['web_probe'],
    });
    expect(custom.candidates.map((c) => c.toolName)).toEqual(['skill']);
  });

  it('treats outputs with unresolvable tool names as protected (fail-safe)', () => {
    const msgs = [
      pu('t1'),
      pfco('orphan-call', 'x'.repeat(4_000)),
      { type: 'function_call_output', output: 'y'.repeat(4_000) }, // no call_id at all
      pu('t2'),
      pa('a'),
    ];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates).toEqual([]);
  });

  it('skips already-pruned markers and non-string outputs', () => {
    const msgs = [
      pu('t1'),
      pfc('c1', 'read_file'),
      pfco('c1', PRUNE_CLEARED_MARKER),
      pfc('c2', 'read_file'),
      pfco('c2', pruneStoredMarker('/tmp/x.txt')),
      pfc('c3', 'read_file'),
      pfco('c3', { structured: 'output' }),
      pu('t2'),
      pa('a'),
    ];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates).toEqual([]);
  });

  it('returns an empty plan when the reclaim falls below the minimum', () => {
    const msgs = [
      pu('t1'),
      pfc('c1', 'read_file'),
      pfco('c1', 'x'.repeat(400)), // 100 tokens
      pu('t2'),
      pa('a'),
    ];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 101,
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.reclaimedTokens).toBe(0);
  });

  it('orders candidates oldest first and handles histories with no user messages', () => {
    const big = 'x'.repeat(4_000);
    const msgs = [
      pfc('c1', 'read_file'),
      pfco('c1', big),
      pfc('c2', 'run_command'),
      pfco('c2', big),
      pa('tail'),
    ];
    // No user messages → only the very last item is turn-protected.
    const plan = planToolOutputPrune(msgs, {
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates.map((c) => c.callId)).toEqual(['c1', 'c2']);
    expect(plan.reclaimedTokens).toBe(2_000);
  });

  it('returns an empty plan for empty or non-array input', () => {
    expect(planToolOutputPrune([]).candidates).toEqual([]);
    expect(planToolOutputPrune('not-an-array').candidates).toEqual([]);
    expect(planToolOutputPrune(null).candidates).toEqual([]);
  });

  it('exposes the documented defaults', () => {
    expect(PRUNE_PROTECT_RECENT_TURNS).toBe(2);
    expect(PRUNE_PROTECT_RECENT_TOKENS).toBe(40_000);
    expect(PRUNE_MIN_RECLAIM_TOKENS).toBe(20_000);
    expect(DEFAULT_PRUNE_PROTECTED_TOOLS).toEqual(['skill']);
    expect(PRUNE_REDERIVABLE_TOOLS).toContain('read_file');
    expect(PRUNE_REDERIVABLE_TOOLS).toContain('run_command');
    expect(pruneStoredMarker('/a/b.txt')).toBe('[Tool result stored at: /a/b.txt]');
  });
});

describe('planToolOutputPrune — non-object items', () => {
  it('ignores primitive and null items everywhere in the walk', () => {
    const big = 'x'.repeat(4_000);
    const msgs = [
      'loose string',
      null,
      7,
      pu('t1'),
      pfc('c1', 'read_file'),
      pfco('c1', big),
      'another string',
      pu('t2'),
      pa('a'),
    ];
    const plan = planToolOutputPrune(msgs, {
      protectRecentTurns: 1,
      protectRecentTokens: 0,
      minReclaimTokens: 1,
    });
    expect(plan.candidates.map((c) => c.callId)).toEqual(['c1']);
  });
});
