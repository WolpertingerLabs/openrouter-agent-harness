import { describe, it, expect } from 'vitest';

import { createRuleRouter } from './rule.js';
import type { RoutingContext } from '../router.js';

/** Minimal RoutingContext for rule-router tests; tweak per case via overrides. */
function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    pseudoModel: 'auto/coding',
    defaultModel: 'openai/gpt-4o-mini',
    sessionId: 'sess-1',
    turn: 0,
    phase: 'turn',
    messages: [],
    input: 'hello',
    instructions: 'be helpful',
    tools: [],
    estimatedTokens: 0,
    ...overrides,
  };
}

describe('createRuleRouter — plumbing', () => {
  it('defaults the name and forwards claim config', () => {
    const router = createRuleRouter({
      provides: ['auto/coding'],
      match: (id) => id === 'router/x',
      rules: [],
      defaultModel: 'm',
    });
    expect(router.name).toBe('rule-router');
    expect(router.provides).toEqual(['auto/coding']);
    expect(router.match?.('router/x')).toBe(true);
  });

  it('honours an explicit name', () => {
    const router = createRuleRouter({ name: 'coding', rules: [], defaultModel: 'm' });
    expect(router.name).toBe('coding');
  });

  it('falls back to the default model (with params + reason) when no rule matches', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'never', minTokens: 999_999 }],
      defaultModel: 'openai/gpt-4o-mini',
      defaultModelParams: { temperature: 0.5 },
      defaultReason: 'no rule matched',
    });
    const decision = await router.route(makeCtx());
    expect(decision).toEqual({
      model: 'openai/gpt-4o-mini',
      modelParams: { temperature: 0.5 },
      reason: 'no rule matched',
    });
  });

  it('returns the first matching rule in order and carries its fields', async () => {
    const router = createRuleRouter({
      rules: [
        { model: 'big', minTokens: 100 },
        { model: 'small', reason: 'short', modelParams: { temperature: 0 }, sticky: false },
      ],
      defaultModel: 'd',
    });
    const decision = await router.route(makeCtx({ estimatedTokens: 10 }));
    expect(decision).toEqual({
      model: 'small',
      reason: 'short',
      modelParams: { temperature: 0 },
      sticky: false,
    });
  });

  it('treats a rule with no conditions as an unconditional catch-all', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'catch-all' }],
      defaultModel: 'd',
    });
    expect((await router.route(makeCtx())).model).toBe('catch-all');
  });
});

describe('createRuleRouter — token conditions', () => {
  const router = createRuleRouter({
    rules: [
      { model: 'huge', minTokens: 50_000 },
      { model: 'tiny', maxTokens: 100 },
    ],
    defaultModel: 'mid',
  });

  it('matches minTokens at/above the threshold', async () => {
    expect((await router.route(makeCtx({ estimatedTokens: 60_000 }))).model).toBe('huge');
  });

  it('skips minTokens below the threshold (and maxTokens above it) → default', async () => {
    expect((await router.route(makeCtx({ estimatedTokens: 49_999 }))).model).toBe('mid');
  });

  it('matches maxTokens at/below the threshold', async () => {
    expect((await router.route(makeCtx({ estimatedTokens: 100 }))).model).toBe('tiny');
  });

  it('skips maxTokens above the threshold → default', async () => {
    expect((await router.route(makeCtx({ estimatedTokens: 5_000 }))).model).toBe('mid');
  });
});

describe('createRuleRouter — tool presence', () => {
  it('matches when a single named tool is visible', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'with-edit', hasTool: 'edit_file' }],
      defaultModel: 'plain',
    });
    expect((await router.route(makeCtx({ tools: ['read_file', 'edit_file'] }))).model).toBe('with-edit');
    expect((await router.route(makeCtx({ tools: ['read_file'] }))).model).toBe('plain');
  });

  it('requires every tool in a list to be present', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'full', hasTool: ['edit_file', 'run_command'] }],
      defaultModel: 'plain',
    });
    expect((await router.route(makeCtx({ tools: ['edit_file', 'run_command'] }))).model).toBe('full');
    expect((await router.route(makeCtx({ tools: ['edit_file'] }))).model).toBe('plain');
  });
});

describe('createRuleRouter — keyword / regex', () => {
  it('matches a case-insensitive substring over instructions + input', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'coder', keyword: 'refactor' }],
      defaultModel: 'chat',
    });
    expect((await router.route(makeCtx({ input: 'Please REFACTOR this' }))).model).toBe('coder');
    expect((await router.route(makeCtx({ instructions: 'You refactor code' }))).model).toBe('coder');
    expect((await router.route(makeCtx({ input: 'just chatting' }))).model).toBe('chat');
  });

  it('matches when ANY keyword in a list hits', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'coder', keyword: ['debug', 'refactor'] }],
      defaultModel: 'chat',
    });
    expect((await router.route(makeCtx({ input: 'help me debug' }))).model).toBe('coder');
    expect((await router.route(makeCtx({ input: 'nothing here' }))).model).toBe('chat');
  });

  it('matches a RegExp against the request text', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'sql', keyword: /\bSELECT\b/i }],
      defaultModel: 'chat',
    });
    expect((await router.route(makeCtx({ input: 'select * from t' }))).model).toBe('sql');
    expect((await router.route(makeCtx({ input: 'no query' }))).model).toBe('chat');
  });

  it('serializes non-string input for keyword matching', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'json', keyword: 'needle' }],
      defaultModel: 'chat',
    });
    expect((await router.route(makeCtx({ input: { field: 'a needle here' } }))).model).toBe('json');
  });

  it('handles null/undefined input without throwing', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'coder', keyword: 'refactor' }],
      defaultModel: 'chat',
    });
    expect((await router.route(makeCtx({ input: null }))).model).toBe('chat');
  });
});

describe('createRuleRouter — when predicate', () => {
  it('matches when the predicate is true and skips when false', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'compaction-model', when: (ctx) => ctx.phase === 'compaction' }],
      defaultModel: 'turn-model',
    });
    expect((await router.route(makeCtx({ phase: 'compaction' }))).model).toBe('compaction-model');
    expect((await router.route(makeCtx({ phase: 'turn' }))).model).toBe('turn-model');
  });

  it('AND-combines multiple conditions on one rule', async () => {
    const router = createRuleRouter({
      rules: [{ model: 'both', minTokens: 100, keyword: 'urgent' }],
      defaultModel: 'd',
    });
    // token ok but keyword missing → skip
    expect((await router.route(makeCtx({ estimatedTokens: 200, input: 'calm' }))).model).toBe('d');
    // keyword ok but token below → skip
    expect((await router.route(makeCtx({ estimatedTokens: 10, input: 'urgent' }))).model).toBe('d');
    // both hold → match
    expect((await router.route(makeCtx({ estimatedTokens: 200, input: 'urgent' }))).model).toBe('both');
  });
});
