/**
 * `createRuleRouter` — the first canonical {@link RouterPlugin} factory (step 8
 * of `plans/autorouter-pseudomodels.md`).
 *
 * A **rule router** resolves a pseudomodel by walking an ordered list of rules
 * and returning the first one whose conditions all hold for the request, falling
 * back to a configured default model when none match. It is fully synchronous —
 * no network — so it is cheap to run every turn and never needs `init()`.
 *
 * The supported conditions cover the predicates called for in the plan:
 * - **token thresholds** (`minTokens` / `maxTokens`) over `estimatedTokens`,
 * - **tool presence** (`hasTool`) over the visible tool names,
 * - **keyword / regex** (`keyword`) over `instructions` + the request input, and
 * - an arbitrary **`when`** escape hatch over the whole {@link RoutingContext}.
 *
 * A rule with no conditions matches unconditionally, so it can serve as a
 * terminal catch-all if you prefer that to the top-level `defaultModel`.
 */
/** Flatten the request into a single lowercased haystack for keyword matching. */
function requestText(ctx) {
    const input = typeof ctx.input === 'string' ? ctx.input : JSON.stringify(ctx.input ?? '');
    return `${ctx.instructions}\n${input}`;
}
/** Whether the keyword condition matches the request text. */
function keywordMatches(keyword, ctx) {
    const text = requestText(ctx);
    if (keyword instanceof RegExp)
        return keyword.test(text);
    const lower = text.toLowerCase();
    const needles = Array.isArray(keyword) ? keyword : [keyword];
    return needles.some((n) => lower.includes(n.toLowerCase()));
}
/** Whether every named tool is present in the visible tool set. */
function toolsPresent(hasTool, ctx) {
    const wanted = Array.isArray(hasTool) ? hasTool : [hasTool];
    return wanted.every((name) => ctx.tools.includes(name));
}
/** Whether a single rule's conditions all hold for the request. */
function ruleMatches(rule, ctx) {
    if (rule.minTokens !== undefined && ctx.estimatedTokens < rule.minTokens)
        return false;
    if (rule.maxTokens !== undefined && ctx.estimatedTokens > rule.maxTokens)
        return false;
    if (rule.hasTool !== undefined && !toolsPresent(rule.hasTool, ctx))
        return false;
    if (rule.keyword !== undefined && !keywordMatches(rule.keyword, ctx))
        return false;
    if (rule.when !== undefined && !rule.when(ctx))
        return false;
    return true;
}
/**
 * Build a synchronous, rules-based {@link RouterPlugin}. The returned router
 * walks `rules` in order and resolves to the first one whose conditions all
 * hold, or to `defaultModel` when none match.
 */
export function createRuleRouter(opts) {
    const { rules, defaultModel, defaultModelParams, defaultReason } = opts;
    return {
        name: opts.name ?? 'rule-router',
        provides: opts.provides,
        match: opts.match,
        route: (ctx) => {
            for (const rule of rules) {
                if (ruleMatches(rule, ctx)) {
                    return {
                        model: rule.model,
                        modelParams: rule.modelParams,
                        reason: rule.reason,
                        sticky: rule.sticky,
                    };
                }
            }
            return { model: defaultModel, modelParams: defaultModelParams, reason: defaultReason };
        },
    };
}
//# sourceMappingURL=rule.js.map