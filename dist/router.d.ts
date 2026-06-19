/**
 * Routers / pseudomodels — v1 (in-memory router plugins).
 *
 * A **pseudomodel** is a fake model ID (e.g. `auto/coding`, `router/default`)
 * that the harness recognizes and resolves to a *real* model **just before** the
 * request is handed to `@openrouter/agent`. The resolution runs a **router** — a
 * code object supplied by the caller — that inspects the actual request and
 * returns a concrete model. We emulate an OpenRouter-style auto-router, but the
 * routing algorithm lives in our code.
 *
 * This is a sibling to the directory-bundle `plugins` system
 * ({@link ../plugins/spec.js}): `routers` are code-first, carry per-router
 * config + lifecycle, and are passed in-memory to the run constructor. Unlike
 * `plugins`, a router can influence the model call.
 *
 * Step 1 of `plans/autorouter-pseudomodels.md` defines the type surface; step 2
 * adds the pure resolution engine ({@link resolveRoute}, {@link isPseudoModel});
 * step 4 adds the per-run stickiness cache ({@link createRouteCache},
 * {@link resolveRouteCached}). Lifecycle wiring and the canonical factories land
 * in later steps.
 */
import type { AgentLogger } from './agent.js';
/**
 * A code object, supplied by the caller, that claims one or more pseudomodel IDs
 * and resolves each to a concrete model just before a request is dispatched.
 */
export interface RouterPlugin {
    /** Namespace, e.g. "coding-router". Used in `router_decision` events and logs. */
    name: string;
    /** Pseudomodel IDs this router claims, e.g. `["auto/coding"]`. */
    provides?: string[];
    /** Or claim dynamically. Evaluated only if `provides` doesn't match. */
    match?: (id: string) => boolean;
    /**
     * Warm-up before the first turn (fetch supportedModels, build a classifier
     * client, load a table).
     */
    init?: (ctx: RouterInitContext) => void | Promise<void>;
    /** Decide the concrete model for this request. */
    route: (ctx: RoutingContext) => RouteDecision | Promise<RouteDecision>;
    /** Cleanup at run end. */
    dispose?: () => void | Promise<void>;
}
/**
 * Read-only snapshot of the request a router inspects when deciding a model.
 */
export interface RoutingContext {
    /** The fake ID requested. */
    pseudoModel: string;
    /** Fallback if routing fails. */
    defaultModel: string;
    sessionId: string;
    /** Cycle index (0-based). */
    turn: number;
    phase: 'turn' | 'compaction';
    /** Conversation state messages (read-only). */
    messages: ReadonlyArray<unknown>;
    /** This cycle's input. */
    input: unknown;
    /** System prompt. */
    instructions: string;
    /** Visible tool names. */
    tools: ReadonlyArray<string>;
    /** Estimated token count, via `serializeMessagesForEstimate`. */
    estimatedTokens: number;
    budgetRemainingUsd?: number;
    /** What ran last turn — enables stickiness. */
    previousModel?: string;
}
/**
 * The outcome a router returns from {@link RouterPlugin.route}.
 */
export interface RouteDecision {
    /** Concrete model ID. */
    model: string;
    /** Optional per-route param overrides. */
    modelParams?: Record<string, unknown>;
    /** Surfaced in the `router_decision` event. */
    reason?: string;
    /** Default `true`: cache for the run. `false` = re-decide each turn. */
    sticky?: boolean;
}
/**
 * Context handed to {@link RouterPlugin.init} for warm-up.
 */
export interface RouterInitContext {
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
    logger?: AgentLogger;
}
/**
 * The outcome of resolving a (possibly pseudo) model ID against a router
 * registry. Returned by {@link resolveRoute} when some router claims the ID.
 */
export interface RouteResolution {
    /** Concrete model the request should run against. */
    resolvedModel: string;
    /** Per-route param overrides to merge into the request, if any. */
    modelParams?: Record<string, unknown>;
    /** Human-readable rationale from the router, surfaced in events/logs. */
    reason?: string;
    /** {@link RouterPlugin.name} of the router that claimed the ID. */
    routerName: string;
    /**
     * `true` when routing failed (router threw, or resolved to another
     * pseudomodel past the depth guard) and {@link RouteResolution.resolvedModel}
     * is the fail-safe default rather than the router's choice.
     */
    fellBack: boolean;
    /**
     * Whether this resolution should be cached for the run (see
     * {@link resolveRouteCached}). Mirrors {@link RouteDecision.sticky} — `true`
     * by default, `false` when the router opted out. Fallbacks
     * ({@link RouteResolution.fellBack}) are never sticky: a transient failure
     * should be re-decided next turn rather than pinned for the whole run.
     */
    sticky: boolean;
}
/**
 * Whether `model` is a pseudomodel — i.e. some router in `routers` claims it.
 * Registry membership (not a prefix) is the source of truth.
 */
export declare function isPseudoModel(model: string, routers: ReadonlyArray<RouterPlugin>): boolean;
/**
 * Resolve `model` against the router registry, returning the concrete model the
 * request should run against (plus provenance), or `null` when no router claims
 * the ID — in which case the caller uses `model` verbatim.
 *
 * Semantics (see `plans/autorouter-pseudomodels.md` § Resolution semantics):
 * - **First claimer wins**, in array order (`provides` exact, else `match`).
 * - **Depth-1 guard:** if the router resolves to *another* pseudomodel, reject
 *   it and fall back to `ctx.defaultModel` (no pseudo→pseudo loops).
 * - **Fail-safe:** any throw from `route()` falls back to `ctx.defaultModel`.
 *   A routing failure NEVER propagates out of this function.
 *
 * This is pure save for the optional `logger` calls; stickiness/caching is a
 * separate concern layered on top in a later step.
 */
export declare function resolveRoute(model: string, ctx: RoutingContext, routers: ReadonlyArray<RouterPlugin>, logger?: AgentLogger): Promise<RouteResolution | null>;
/**
 * Per-run cache of routing decisions, keyed by `(pseudoModel, phase)`.
 *
 * Stickiness protects the upstream prompt cache and keeps cost predictable: the
 * first decision for a pseudomodel is pinned for the run and reused on later
 * turns instead of re-routing each turn. The key includes `phase` so the
 * `'turn'` and `'compaction'` passes route independently (a run can pin a cheap
 * summarizer for compaction while the main turn rides a different model).
 *
 * Create one per run; never share across runs.
 */
export type RouteCache = Map<string, RouteResolution>;
/** Construct an empty {@link RouteCache} for a single run. */
export declare function createRouteCache(): RouteCache;
/**
 * Build the cache key for a `(pseudoModel, phase)` pair. The NUL separator can't
 * appear in a model ID or phase, so distinct pairs never collide.
 *
 * Exported so a caller can probe {@link RouteCache.has} BEFORE
 * {@link resolveRouteCached} to tell a fresh resolution (cache miss) from a
 * reused sticky decision (cache hit) — the agent loop emits a `router_decision`
 * event only on the cycle that actually routes, not when a pinned sticky
 * decision is replayed.
 */
export declare function routeCacheKey(pseudoModel: string, phase: RoutingContext['phase']): string;
/**
 * Stickiness-aware wrapper over {@link resolveRoute}: returns a cached decision
 * for this `(pseudoModel, phase)` if one was pinned earlier in the run,
 * otherwise resolves fresh and caches the result when it is sticky.
 *
 * Semantics (see `plans/autorouter-pseudomodels.md` § Resolution semantics):
 * - A cache hit short-circuits routing entirely — `route()` is not called again,
 *   so the pinned model survives across turns regardless of changing context.
 * - A miss resolves via {@link resolveRoute}; the result is cached only when
 *   {@link RouteResolution.sticky} is `true`. `sticky: false` decisions and
 *   fallbacks re-decide every turn.
 * - `null` (no router claims `model`) is never cached.
 */
export declare function resolveRouteCached(model: string, ctx: RoutingContext, routers: ReadonlyArray<RouterPlugin>, cache: RouteCache, logger?: AgentLogger): Promise<RouteResolution | null>;
//# sourceMappingURL=router.d.ts.map