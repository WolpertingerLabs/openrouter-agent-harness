import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN,
  COMPACTION_PROMPT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_SAFETY_BUFFER_TOKENS,
  DEFAULT_THRESHOLD_RATIO,
  MODEL_CONTEXT_WINDOWS,
  estimateInstructionsAndToolsTokens,
  estimateMessagesCharLength,
  getModelContextWindow,
  partitionMessages,
  resolveCompactionThresholdChars,
  resolveCompactionThresholdTokens,
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
