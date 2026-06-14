import { describe, it, expect, vi, beforeEach } from 'vitest';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const stepCountIs = (n: number) => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number) => ({ kind: 'maxCost', n });
  const isTurnStartEvent = (e: unknown): e is { type: 'turn.start'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.start';
  const isTurnEndEvent = (e: unknown): e is { type: 'turn.end'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.end';
  const isToolCallOutputEvent = (e: unknown) =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
  class OpenRouter {
    callModel: typeof callModelMock;
    constructor(...args: unknown[]) {
      openRouterCtorMock(...args);
      this.callModel = callModelMock;
    }
  }
  return {
    ...actual,
    OpenRouter,
    stepCountIs,
    maxCost,
    isTurnStartEvent,
    isTurnEndEvent,
    isToolCallOutputEvent,
  };
});

vi.mock('./tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

import { OpenRouterAgentRun } from './agent.js';
import type { RouterPlugin, RoutingContext, RouteDecision, RouterInitContext } from './router.js';
import type { UserInput } from './streaming-input.js';

// The harness default model — the fail-safe fallback a route resolves to when
// it throws (the run's own `model` is the pseudomodel, so it can't be reused).
const DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';

/** A two-input prompt so the run drives two callModel cycles. */
function twoTurnPrompt(): AsyncGenerator<UserInput> {
  return (async function* () {
    yield { content: 'one' };
    yield { content: 'two' };
  })();
}

/** The `model` field of the nth callModel invocation. */
function callModelArg(n: number): Record<string, unknown> {
  return callModelMock.mock.calls[n]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  // Default mock so any drained run completes with an empty stream.
  callModelMock.mockImplementation(() => ({
    async *getFullResponsesStream() {
      /* empty */
    },
    async getResponse() {
      return {
        id: 'r1',
        model: 'mock',
        usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        output: [],
      };
    },
    async cancel() {
      /* noop */
    },
  }));
});

async function drain(run: OpenRouterAgentRun): Promise<void> {
  for await (const _ of run) {
    void _;
  }
}

// Minimal router that never claims a real model — lifecycle-only for these
// tests. `route` is required by the contract but is never reached here because
// no pseudomodel is requested (wiring lands in later steps).
function lifecycleRouter(overrides: Partial<RouterPlugin> = {}): RouterPlugin {
  return {
    name: 'test-router',
    route: (): RouteDecision => ({ model: 'real/model' }),
    ...overrides,
  };
}

describe('OpenRouterAgentRun — router lifecycle', () => {
  it('fires init once with the full init context, then dispose once', async () => {
    const init = vi.fn();
    const dispose = vi.fn();
    let ctx: RouterInitContext | undefined;
    const router = lifecycleRouter({
      init: (c) => {
        ctx = c;
        init();
      },
      dispose,
    });
    const logger = vi.fn();

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-lifecycle',
      prompt: 'hi',
      model: 'real/model',
      baseUrl: 'https://example.test',
      persistSession: false,
      routers: [router],
      logger,
    });
    await drain(run);

    expect(init).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(ctx?.apiKey).toBe('sk-test');
    expect(ctx?.defaultModel).toBe('real/model');
    expect(ctx?.baseUrl).toBe('https://example.test');
    expect(ctx?.logger).toBe(logger);
  });

  it('omits baseUrl and logger from the init context when not configured', async () => {
    let ctx: RouterInitContext | undefined;
    const router = lifecycleRouter({
      init: (c) => {
        ctx = c;
      },
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-no-optionals',
      prompt: 'hi',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(ctx).toBeDefined();
    expect(ctx?.baseUrl).toBeUndefined();
    expect(ctx?.logger).toBeUndefined();
  });

  it('runs cleanly when a router declares neither init nor dispose', async () => {
    const router = lifecycleRouter();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-bare',
      prompt: 'hi',
      persistSession: false,
      routers: [router],
    });
    await expect(drain(run)).resolves.toBeUndefined();
  });

  it('treats an init failure as non-fatal — run completes and dispose still fires (Error and non-Error)', async () => {
    const dispose = vi.fn();
    const errorRouter = lifecycleRouter({
      name: 'throws-error',
      init: () => {
        throw new Error('boom');
      },
      dispose,
    });
    const stringRouter = lifecycleRouter({
      name: 'throws-string',
      init: () => {
        throw 'plain-string-failure';
      },
    });
    const warnings: Array<{ msg: string; ctx?: unknown }> = [];
    const logger = vi.fn((level: string, msg: string, ctx?: unknown) => {
      if (level === 'warn') warnings.push({ msg, ctx });
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-init-fail',
      prompt: 'hi',
      persistSession: false,
      routers: [errorRouter, stringRouter],
      logger,
    });
    await expect(drain(run)).resolves.toBeUndefined();

    // Both failing inits warned; dispose for the recorded router still fired.
    const initWarnings = warnings.filter((w) => w.msg.includes('Router init failed'));
    expect(initWarnings).toHaveLength(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    const errs = initWarnings.map((w) => (w.ctx as { error?: string }).error);
    expect(errs).toContain('boom');
    expect(errs).toContain('plain-string-failure');
  });

  it('swallows and logs a dispose failure at error level', async () => {
    const router = lifecycleRouter({
      dispose: () => {
        throw new Error('dispose-blew-up');
      },
    });
    const errors: string[] = [];
    const logger = vi.fn((level: string, msg: string) => {
      if (level === 'error') errors.push(msg);
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-dispose-fail',
      prompt: 'hi',
      persistSession: false,
      routers: [router],
      logger,
    });
    await expect(drain(run)).resolves.toBeUndefined();
    expect(errors.some((m) => m.includes('Router dispose failed'))).toBe(true);
  });

  it('does not fire init or dispose when the run aborts before the init phase', async () => {
    const init = vi.fn();
    const dispose = vi.fn();
    const router = lifecycleRouter({ init, dispose });

    const ac = new AbortController();
    ac.abort();
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-aborted',
      prompt: 'hi',
      persistSession: false,
      routers: [router],
      signal: ac.signal,
    });
    await drain(run);

    expect(init).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('awaits an async init before continuing', async () => {
    const order: string[] = [];
    const router = lifecycleRouter({
      init: async (_c: RouterInitContext) => {
        await Promise.resolve();
        order.push('init');
      },
      route: (_c: RoutingContext): RouteDecision => ({ model: 'real/model' }),
    });
    callModelMock.mockImplementation(() => {
      order.push('callModel');
      return {
        async *getFullResponsesStream() {
          /* empty */
        },
        async getResponse() {
          return {
            id: 'r1',
            model: 'mock',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
        async cancel() {
          /* noop */
        },
      };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-async-init',
      prompt: 'hi',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(order[0]).toBe('init');
    expect(order).toContain('callModel');
  });
});

describe('OpenRouterAgentRun — router wiring (main callModel)', () => {
  it('substitutes a pseudomodel with the router-resolved concrete model', async () => {
    const router: RouterPlugin = {
      name: 'coding-router',
      provides: ['auto/coding'],
      route: (): RouteDecision => ({ model: 'real/concrete' }),
    };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-resolve',
      prompt: 'hi',
      model: 'auto/coding',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(callModelArg(0).model).toBe('real/concrete');
  });

  it('passes the model through verbatim when no router claims it', async () => {
    const route = vi.fn((): RouteDecision => ({ model: 'never/used' }));
    const router: RouterPlugin = { name: 'coding-router', provides: ['auto/coding'], route };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-passthrough',
      prompt: 'hi',
      model: 'real/model',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(callModelArg(0).model).toBe('real/model');
    expect(route).not.toHaveBeenCalled();
  });

  it('runs unrouted when no routers are configured at all', async () => {
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-no-routers',
      prompt: 'hi',
      model: 'real/model',
      persistSession: false,
    });
    await drain(run);

    expect(callModelArg(0).model).toBe('real/model');
  });

  it('merges per-route modelParams, overriding run-level modelParams', async () => {
    const router: RouterPlugin = {
      name: 'r',
      provides: ['auto/x'],
      route: (): RouteDecision => ({
        model: 'real/x',
        modelParams: { temperature: 0.2, top_p: 0.5 },
      }),
    };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-params',
      prompt: 'hi',
      model: 'auto/x',
      persistSession: false,
      modelParams: { temperature: 0.9 },
      routers: [router],
    });
    await drain(run);

    const req = callModelArg(0);
    expect(req.model).toBe('real/x');
    expect(req.temperature).toBe(0.2);
    expect(req.top_p).toBe(0.5);
  });

  it('keeps a sticky (default) decision pinned across turns — route runs once', async () => {
    let n = 0;
    const route = vi.fn((): RouteDecision => ({ model: `sticky/${n++}` }));
    const router: RouterPlugin = { name: 'r', provides: ['auto/x'], route };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-sticky',
      prompt: twoTurnPrompt(),
      model: 'auto/x',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(callModelMock).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledTimes(1);
    expect(callModelArg(0).model).toBe('sticky/0');
    expect(callModelArg(1).model).toBe('sticky/0');
  });

  it('re-decides every turn when sticky is false', async () => {
    let n = 0;
    const route = vi.fn((): RouteDecision => ({ model: `fresh/${n++}`, sticky: false }));
    const router: RouterPlugin = { name: 'r', provides: ['auto/x'], route };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-nonsticky',
      prompt: twoTurnPrompt(),
      model: 'auto/x',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(route).toHaveBeenCalledTimes(2);
    expect(callModelArg(0).model).toBe('fresh/0');
    expect(callModelArg(1).model).toBe('fresh/1');
  });

  it('threads turn index and previousModel into the RoutingContext', async () => {
    const seen: RoutingContext[] = [];
    let n = 0;
    const router: RouterPlugin = {
      name: 'r',
      provides: ['auto/x'],
      route: (ctx): RouteDecision => {
        seen.push(ctx);
        return { model: `m/${n++}`, sticky: false };
      },
    };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-ctx',
      prompt: twoTurnPrompt(),
      model: 'auto/x',
      persistSession: false,
      routers: [router],
    });
    await drain(run);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.turn).toBe(0);
    expect(seen[0]?.previousModel).toBeUndefined();
    expect(seen[1]?.turn).toBe(1);
    expect(seen[1]?.previousModel).toBe('m/0');
  });

  it('exposes the request shape (pseudoModel, phase, budget, tokens) to the router', async () => {
    let ctx: RoutingContext | undefined;
    const router: RouterPlugin = {
      name: 'r',
      provides: ['auto/x'],
      route: (c): RouteDecision => {
        ctx = c;
        return { model: 'real/x' };
      },
    };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-shape',
      prompt: 'hi',
      model: 'auto/x',
      persistSession: false,
      maxBudgetUsd: 5,
      routers: [router],
    });
    await drain(run);

    expect(ctx?.pseudoModel).toBe('auto/x');
    expect(ctx?.defaultModel).toBe(DEFAULT_MODEL);
    expect(ctx?.phase).toBe('turn');
    expect(ctx?.sessionId).toBe('r-shape');
    expect(ctx?.budgetRemainingUsd).toBe(5);
    expect(typeof ctx?.estimatedTokens).toBe('number');
    expect(Array.isArray(ctx?.tools)).toBe(true);
    expect(Array.isArray(ctx?.messages)).toBe(true);
    expect(ctx?.input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('falls back to the default model (and re-decides) when the router throws', async () => {
    const route = vi.fn((): RouteDecision => {
      throw new Error('routing boom');
    });
    const router: RouterPlugin = { name: 'r', provides: ['auto/x'], route };
    const warnings: string[] = [];
    const logger = vi.fn((level: string, msg: string) => {
      if (level === 'warn') warnings.push(msg);
    });
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-test',
      sessionId: 'r-throw',
      prompt: twoTurnPrompt(),
      model: 'auto/x',
      persistSession: false,
      routers: [router],
      logger,
    });
    await drain(run);

    expect(callModelArg(0).model).toBe(DEFAULT_MODEL);
    expect(callModelArg(1).model).toBe(DEFAULT_MODEL);
    // Fallbacks are never sticky — the router is re-consulted next turn.
    expect(route).toHaveBeenCalledTimes(2);
    expect(warnings.some((m) => m.includes('falling back to default'))).toBe(true);
  });
});
