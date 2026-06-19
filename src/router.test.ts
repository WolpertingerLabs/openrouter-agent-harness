import { describe, it, expect, vi } from 'vitest';

import {
  isPseudoModel,
  resolveRoute,
  resolveRouteCached,
  createRouteCache,
  type RouterPlugin,
  type RoutingContext,
  type RouteDecision,
} from './router.js';

/** Minimal RoutingContext for engine tests; fields the engine ignores are stubbed. */
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

/** Build a router whose `route` always returns the given decision. */
function staticRouter(
  name: string,
  decision: RouteDecision,
  claim: Pick<RouterPlugin, 'provides' | 'match'>,
): RouterPlugin {
  return { name, route: () => decision, ...claim };
}

describe('isPseudoModel', () => {
  it('claims by exact provides match', () => {
    const routers = [staticRouter('r', { model: 'x' }, { provides: ['auto/coding'] })];
    expect(isPseudoModel('auto/coding', routers)).toBe(true);
    expect(isPseudoModel('auto/other', routers)).toBe(false);
  });

  it('claims by match predicate when provides does not match', () => {
    const routers = [
      staticRouter('r', { model: 'x' }, { match: (id) => id.startsWith('router/') }),
    ];
    expect(isPseudoModel('router/anything', routers)).toBe(true);
    expect(isPseudoModel('openai/gpt-4o', routers)).toBe(false);
  });

  it('returns false with no routers', () => {
    expect(isPseudoModel('auto/coding', [])).toBe(false);
  });

  it('treats a throwing matcher as not-claiming', () => {
    const routers = [
      staticRouter(
        'boom',
        { model: 'x' },
        {
          match: () => {
            throw new Error('matcher exploded');
          },
        },
      ),
    ];
    expect(isPseudoModel('anything', routers)).toBe(false);
  });
});

describe('resolveRoute', () => {
  it('returns null when no router claims the model', async () => {
    const routers = [staticRouter('r', { model: 'x' }, { provides: ['auto/coding'] })];
    const res = await resolveRoute('openai/gpt-4o', makeCtx(), routers);
    expect(res).toBeNull();
  });

  it('resolves via the claiming router (provides) and carries through fields', async () => {
    const routers = [
      staticRouter(
        'coding-router',
        { model: 'anthropic/claude-sonnet-4', modelParams: { temperature: 0.2 }, reason: 'code task' },
        { provides: ['auto/coding'] },
      ),
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers);
    expect(res).toEqual({
      resolvedModel: 'anthropic/claude-sonnet-4',
      modelParams: { temperature: 0.2 },
      reason: 'code task',
      routerName: 'coding-router',
      fellBack: false,
      sticky: true,
    });
  });

  it('resolves via the claiming router (match)', async () => {
    const routers = [
      staticRouter(
        'dyn',
        { model: 'openai/gpt-4o' },
        { match: (id) => id === 'router/dynamic' },
      ),
    ];
    const res = await resolveRoute('router/dynamic', makeCtx(), routers);
    expect(res?.resolvedModel).toBe('openai/gpt-4o');
    expect(res?.routerName).toBe('dyn');
    expect(res?.fellBack).toBe(false);
  });

  it('picks the first claiming router in array order', async () => {
    const routers = [
      staticRouter('first', { model: 'model-A' }, { provides: ['auto/coding'] }),
      staticRouter('second', { model: 'model-B' }, { provides: ['auto/coding'] }),
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers);
    expect(res?.routerName).toBe('first');
    expect(res?.resolvedModel).toBe('model-A');
  });

  it('rejects a resolution to another pseudomodel (depth guard) and falls back', async () => {
    const logger = vi.fn();
    const routers = [
      staticRouter('looper', { model: 'auto/other' }, { provides: ['auto/coding'] }),
      staticRouter('other', { model: 'real' }, { provides: ['auto/other'] }),
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers, logger);
    expect(res).toEqual({
      resolvedModel: 'openai/gpt-4o-mini',
      routerName: 'looper',
      fellBack: true,
      sticky: false,
    });
    expect(logger).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('depth guard'),
      expect.objectContaining({ resolvedModel: 'auto/other' }),
    );
  });

  it('falls back to the default model when route() throws', async () => {
    const logger = vi.fn();
    const routers: RouterPlugin[] = [
      {
        name: 'thrower',
        provides: ['auto/coding'],
        route: () => {
          throw new Error('routing kaput');
        },
      },
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers, logger);
    expect(res).toEqual({
      resolvedModel: 'openai/gpt-4o-mini',
      routerName: 'thrower',
      fellBack: true,
      sticky: false,
    });
    expect(logger).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('threw while routing'),
      expect.objectContaining({ error: 'routing kaput' }),
    );
  });

  it('stringifies non-Error throws in the fallback log', async () => {
    const logger = vi.fn();
    const routers: RouterPlugin[] = [
      {
        name: 'thrower',
        provides: ['auto/coding'],
        route: () => {
          throw 'plain string failure';
        },
      },
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers, logger);
    expect(res?.fellBack).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({ error: 'plain string failure' }),
    );
  });

  it('awaits an async route()', async () => {
    const routers: RouterPlugin[] = [
      {
        name: 'async',
        provides: ['auto/coding'],
        route: async () => ({ model: 'async/model' }),
      },
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers);
    expect(res?.resolvedModel).toBe('async/model');
  });

  it('works without a logger on the fallback path', async () => {
    const routers: RouterPlugin[] = [
      {
        name: 'thrower',
        provides: ['auto/coding'],
        route: () => {
          throw new Error('no logger here');
        },
      },
    ];
    const res = await resolveRoute('auto/coding', makeCtx(), routers);
    expect(res?.fellBack).toBe(true);
  });

  it('defaults sticky to true and honours an explicit sticky flag', async () => {
    const sticky = await resolveRoute(
      'auto/coding',
      makeCtx(),
      [staticRouter('r', { model: 'm' }, { provides: ['auto/coding'] })],
    );
    expect(sticky?.sticky).toBe(true);

    const nonSticky = await resolveRoute(
      'auto/coding',
      makeCtx(),
      [staticRouter('r', { model: 'm', sticky: false }, { provides: ['auto/coding'] })],
    );
    expect(nonSticky?.sticky).toBe(false);
  });
});

describe('resolveRouteCached', () => {
  /** A router that returns a fresh model each call so we can detect re-routing. */
  function countingRouter(
    decision: Omit<RouteDecision, 'model'> = {},
  ): { router: RouterPlugin; calls: () => number } {
    let n = 0;
    const router: RouterPlugin = {
      name: 'counter',
      provides: ['auto/coding'],
      route: () => {
        n += 1;
        return { model: `model-${n}`, ...decision };
      },
    };
    return { router, calls: () => n };
  }

  it('returns null (and caches nothing) when no router claims the model', async () => {
    const cache = createRouteCache();
    const routers = [staticRouter('r', { model: 'x' }, { provides: ['auto/coding'] })];
    const res = await resolveRouteCached('openai/gpt-4o', makeCtx(), routers, cache);
    expect(res).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('pins the first sticky decision and reuses it without re-routing', async () => {
    const cache = createRouteCache();
    const { router, calls } = countingRouter();

    const first = await resolveRouteCached('auto/coding', makeCtx({ turn: 0 }), [router], cache);
    const second = await resolveRouteCached('auto/coding', makeCtx({ turn: 1 }), [router], cache);

    expect(first?.resolvedModel).toBe('model-1');
    expect(second?.resolvedModel).toBe('model-1');
    expect(calls()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('re-decides every turn when the decision is sticky:false', async () => {
    const cache = createRouteCache();
    const { router, calls } = countingRouter({ sticky: false });

    const first = await resolveRouteCached('auto/coding', makeCtx({ turn: 0 }), [router], cache);
    const second = await resolveRouteCached('auto/coding', makeCtx({ turn: 1 }), [router], cache);

    expect(first?.resolvedModel).toBe('model-1');
    expect(second?.resolvedModel).toBe('model-2');
    expect(calls()).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('caches the turn and compaction phases independently', async () => {
    const cache = createRouteCache();
    const { router, calls } = countingRouter();

    const turn = await resolveRouteCached('auto/coding', makeCtx({ phase: 'turn' }), [router], cache);
    const comp = await resolveRouteCached(
      'auto/coding',
      makeCtx({ phase: 'compaction' }),
      [router],
      cache,
    );

    expect(turn?.resolvedModel).toBe('model-1');
    expect(comp?.resolvedModel).toBe('model-2');
    expect(calls()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('does not cache fallbacks — re-routes after a transient throw', async () => {
    const cache = createRouteCache();
    let n = 0;
    const router: RouterPlugin = {
      name: 'flaky',
      provides: ['auto/coding'],
      route: () => {
        n += 1;
        if (n === 1) throw new Error('transient');
        return { model: 'recovered' };
      },
    };

    const first = await resolveRouteCached('auto/coding', makeCtx(), [router], cache);
    expect(first?.fellBack).toBe(true);
    expect(cache.size).toBe(0);

    const second = await resolveRouteCached('auto/coding', makeCtx(), [router], cache);
    expect(second?.resolvedModel).toBe('recovered');
    expect(second?.fellBack).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('forwards the logger to the underlying resolveRoute', async () => {
    const cache = createRouteCache();
    const logger = vi.fn();
    const routers: RouterPlugin[] = [
      {
        name: 'thrower',
        provides: ['auto/coding'],
        route: () => {
          throw new Error('kaboom');
        },
      },
    ];
    await resolveRouteCached('auto/coding', makeCtx(), routers, cache, logger);
    expect(logger).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('threw while routing'),
      expect.objectContaining({ error: 'kaboom' }),
    );
  });
});
