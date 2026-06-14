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
 * adds the pure resolution engine ({@link resolveRoute}, {@link isPseudoModel}).
 * Lifecycle wiring, stickiness, and the canonical factories land in later steps.
 */
/**
 * Find the first router (in array order) that claims `model` — via an exact
 * `provides` entry first, then a dynamic `match`. A throwing `match` is treated
 * as "does not claim" so a misbehaving router can never crash claim detection.
 */
function findClaimingRouter(model, routers) {
    for (const router of routers) {
        if (router.provides?.includes(model))
            return router;
        if (router.match) {
            try {
                if (router.match(model))
                    return router;
            }
            catch {
                // A throwing matcher does not claim the ID; keep scanning.
            }
        }
    }
    return undefined;
}
/**
 * Whether `model` is a pseudomodel — i.e. some router in `routers` claims it.
 * Registry membership (not a prefix) is the source of truth.
 */
export function isPseudoModel(model, routers) {
    return findClaimingRouter(model, routers) !== undefined;
}
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
export async function resolveRoute(model, ctx, routers, logger) {
    const router = findClaimingRouter(model, routers);
    if (!router)
        return null;
    try {
        const decision = await router.route(ctx);
        if (isPseudoModel(decision.model, routers)) {
            logger?.('warn', 'Router resolved to another pseudomodel — rejecting (depth guard) and falling back to default', {
                router: router.name,
                pseudoModel: model,
                resolvedModel: decision.model,
                defaultModel: ctx.defaultModel,
            });
            return { resolvedModel: ctx.defaultModel, routerName: router.name, fellBack: true };
        }
        return {
            resolvedModel: decision.model,
            modelParams: decision.modelParams,
            reason: decision.reason,
            routerName: router.name,
            fellBack: false,
        };
    }
    catch (err) {
        logger?.('warn', 'Router threw while routing — falling back to default', {
            router: router.name,
            pseudoModel: model,
            defaultModel: ctx.defaultModel,
            error: err instanceof Error ? err.message : String(err),
        });
        return { resolvedModel: ctx.defaultModel, routerName: router.name, fellBack: true };
    }
}
//# sourceMappingURL=router.js.map