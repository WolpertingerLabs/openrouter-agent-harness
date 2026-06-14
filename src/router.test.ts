import { describe, it, expect, vi } from 'vitest';

import {
  isPseudoModel,
  resolveRoute,
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
});
