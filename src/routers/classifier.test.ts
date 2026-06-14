import { describe, it, expect, vi, afterEach } from 'vitest';

// The default client path builds a real `OpenRouter`; stub the module so we can
// drive `callModel` without a network client. `callModel` is an own (per-
// instance) property, not on the prototype, so a prototype spy can't reach it —
// a module mock is the cleanest seam. Behaviour tests below inject their own
// `createClient` and never touch this mock.
const { mockCallModel } = vi.hoisted(() => ({ mockCallModel: vi.fn() }));
vi.mock('@openrouter/agent', () => ({
  OpenRouter: class {
    callModel = mockCallModel;
    constructor(public opts: unknown) {}
  },
}));

import { createClassifierRouter, type ClassifierClient } from './classifier.js';
import type { RoutingContext, RouterInitContext } from '../router.js';
import type { AgentLogger } from '../agent.js';

/** Minimal RoutingContext for classifier tests; tweak per case via overrides. */
function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    pseudoModel: 'auto/coding',
    defaultModel: 'openai/gpt-4o-mini',
    sessionId: 'sess-1',
    turn: 0,
    phase: 'turn',
    messages: [],
    input: 'refactor this function',
    instructions: 'be helpful',
    tools: [],
    estimatedTokens: 0,
    ...overrides,
  };
}

/** A one-shot async iterable over a fixed list of stream events. */
function makeStream(events: ReadonlyArray<unknown>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

/** A `response.output_text.delta` event carrying `delta`. */
function textDelta(delta: string): unknown {
  return { type: 'response.output_text.delta', delta };
}

/**
 * Build an injectable {@link ClassifierClient} factory that replays `events`
 * (or throws `throwOn`) and records every `callModel` request for assertions.
 */
function recordingFactory(opts: {
  events?: ReadonlyArray<unknown>;
  throwOnCall?: boolean;
  throwInStream?: boolean;
}): { factory: (ctx: RouterInitContext) => ClassifierClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const factory = (): ClassifierClient => ({
    callModel: (req) => {
      calls.push(req);
      if (opts.throwOnCall) throw new Error('boom-call');
      return {
        getFullResponsesStream: () => {
          if (opts.throwInStream) {
            return {
              // eslint-disable-next-line require-yield
              async *[Symbol.asyncIterator]() {
                throw new Error('boom-stream');
              },
            };
          }
          return makeStream(opts.events ?? [textDelta('small')]);
        },
      };
    },
  });
  return { factory, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createClassifierRouter — plumbing', () => {
  it('defaults the name and forwards claim config', () => {
    const router = createClassifierRouter({
      provides: ['auto/coding'],
      match: (id) => id === 'router/x',
      models: { a: 'm-a' },
      defaultLabel: 'a',
    });
    expect(router.name).toBe('classifier-router');
    expect(router.provides).toEqual(['auto/coding']);
    expect(router.match?.('router/x')).toBe(true);
  });

  it('honours an explicit name', () => {
    const router = createClassifierRouter({
      name: 'coding',
      models: { a: 'm-a' },
      defaultLabel: 'a',
    });
    expect(router.name).toBe('coding');
  });

  it('throws when defaultLabel is not a key of models', () => {
    expect(() =>
      createClassifierRouter({ models: { a: 'm-a' }, defaultLabel: 'b' }),
    ).toThrow(/defaultLabel "b" is not a key/);
  });
});

describe('createClassifierRouter — routing', () => {
  it('maps an exact label to its model', async () => {
    const { factory } = recordingFactory({ events: [textDelta('big')] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    const decision = await router.route(makeCtx());
    expect(decision.model).toBe('anthropic/claude');
    expect(decision.reason).toBe('classified as "big"');
  });

  it('matches a label case-insensitively after trimming whitespace', async () => {
    const { factory } = recordingFactory({ events: [textDelta('  BIG \n')] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('anthropic/claude');
  });

  it('matches a label that appears as a substring of the reply', async () => {
    const { factory } = recordingFactory({
      events: [textDelta('I think this is the big bucket')],
    });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('anthropic/claude');
  });

  it('falls back to defaultLabel on an empty reply (and warns)', async () => {
    const logger = vi.fn<AgentLogger>();
    const { factory } = recordingFactory({ events: [] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd', logger });
    const decision = await router.route(makeCtx());
    expect(decision.model).toBe('openai/mini');
    expect(logger).toHaveBeenCalledWith('warn', expect.stringContaining('unrecognized'), expect.any(Object));
  });

  it('falls back to defaultLabel when the reply names no known label', async () => {
    const { factory } = recordingFactory({ events: [textDelta('purple')] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
  });

  it('falls back to defaultLabel when callModel throws (and warns)', async () => {
    const logger = vi.fn<AgentLogger>();
    const { factory } = recordingFactory({ throwOnCall: true });
    const router = createClassifierRouter({
      name: 'cls',
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd', logger });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
    expect(logger).toHaveBeenCalledWith('warn', expect.stringContaining('threw'), expect.any(Object));
  });

  it('stringifies a non-Error throw in the warning (default name)', async () => {
    const logger = vi.fn<AgentLogger>();
    const factory = (): ClassifierClient => ({
      callModel: () => {
        throw 'plain-string-failure';
      },
    });
    const router = createClassifierRouter({
      models: { small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd', logger });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
    expect(logger).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({ router: 'classifier-router', error: 'plain-string-failure' }),
    );
  });

  it('falls back to defaultLabel when the stream throws mid-iteration', async () => {
    const { factory } = recordingFactory({ throwInStream: true });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
  });

  it('uses defaultLabel when route is called before init (no client)', async () => {
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
    });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
  });
});

describe('createClassifierRouter — decision fields', () => {
  it('applies per-label modelParams when configured', async () => {
    const { factory } = recordingFactory({ events: [textDelta('big')] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      modelParams: { big: { temperature: 0 } },
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect(await router.route(makeCtx())).toEqual({
      model: 'anthropic/claude',
      modelParams: { temperature: 0 },
      reason: 'classified as "big"',
    });
  });

  it('omits modelParams when none configured for the chosen label', async () => {
    const { factory } = recordingFactory({ events: [textDelta('small')] });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
      modelParams: { big: { temperature: 0 } },
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    const decision = await router.route(makeCtx());
    expect(decision).not.toHaveProperty('modelParams');
  });

  it('forwards the sticky option, and omits it when unset', async () => {
    const mk = (sticky?: boolean) => {
      const { factory } = recordingFactory({ events: [textDelta('small')] });
      return createClassifierRouter({
        models: { small: 'openai/mini' },
        defaultLabel: 'small',
        ...(sticky !== undefined && { sticky }),
        createClient: factory,
      });
    };
    const stickyFalse = mk(false);
    await stickyFalse.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect((await stickyFalse.route(makeCtx())).sticky).toBe(false);

    const unset = mk();
    await unset.init?.({ apiKey: 'k', defaultModel: 'd' });
    expect(await unset.route(makeCtx())).not.toHaveProperty('sticky');
  });
});

describe('createClassifierRouter — stream parsing & input building', () => {
  it('accumulates only text deltas and ignores other events / non-string deltas', async () => {
    const { factory } = recordingFactory({
      events: [
        'a-bare-string',
        { type: 'turn.start' },
        { type: 'response.output_text.delta', delta: 42 },
        textDelta('sm'),
        { type: 'response.output_text.delta' },
        textDelta('all'),
      ],
    });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'big',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    // deltas concatenate to "small" → matches the `small` label.
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
  });

  it('builds the default classification input from instructions + string input', async () => {
    const { factory, calls } = recordingFactory({ events: [textDelta('small')] });
    const router = createClassifierRouter({
      models: { small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    await router.route(makeCtx({ instructions: 'sys text', input: 'user text' }));
    expect(calls[0].input).toBe('System instructions:\nsys text\n\nRequest:\nuser text');
    expect(calls[0].instructions).toContain('exactly one of these categories: small');
    expect(calls[0].model).toBe('google/gemini-2.5-flash');
  });

  it('serializes non-string input and tolerates null input', async () => {
    const { factory, calls } = recordingFactory({ events: [textDelta('small')] });
    const router = createClassifierRouter({
      models: { small: 'openai/mini' },
      defaultLabel: 'small',
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    await router.route(makeCtx({ input: { field: 'x' } }));
    await router.route(makeCtx({ input: null }));
    expect(calls[0].input).toContain('{"field":"x"}');
    expect(calls[1].input).toContain('Request:\n');
  });

  it('honours a custom classifierModel, buildInstructions and buildInput', async () => {
    const { factory, calls } = recordingFactory({ events: [textDelta('small')] });
    const router = createClassifierRouter({
      models: { small: 'openai/mini' },
      defaultLabel: 'small',
      classifierModel: 'custom/cheap',
      buildInstructions: (labels) => `pick: ${labels.join('|')}`,
      buildInput: (ctx) => `only:${String(ctx.input)}`,
      createClient: factory,
    });
    await router.init?.({ apiKey: 'k', defaultModel: 'd' });
    await router.route(makeCtx({ input: 'hi' }));
    expect(calls[0].model).toBe('custom/cheap');
    expect(calls[0].instructions).toBe('pick: small');
    expect(calls[0].input).toBe('only:hi');
  });
});

describe('createClassifierRouter — default OpenRouter client', () => {
  afterEach(() => mockCallModel.mockReset());

  it('builds a real OpenRouter client (with baseUrl) and routes through it', async () => {
    mockCallModel.mockReturnValue({ getFullResponsesStream: () => makeStream([textDelta('big')]) });
    const router = createClassifierRouter({
      models: { big: 'anthropic/claude', small: 'openai/mini' },
      defaultLabel: 'small',
    });
    await router.init?.({ apiKey: 'sk-test', baseUrl: 'https://example.test', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('anthropic/claude');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('builds the default client without a baseUrl', async () => {
    mockCallModel.mockReturnValue({ getFullResponsesStream: () => makeStream([textDelta('small')]) });
    const router = createClassifierRouter({
      models: { small: 'openai/mini' },
      defaultLabel: 'small',
    });
    await router.init?.({ apiKey: 'sk-test', defaultModel: 'd' });
    expect((await router.route(makeCtx())).model).toBe('openai/mini');
  });
});
