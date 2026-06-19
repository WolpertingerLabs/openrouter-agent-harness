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

import type { RouterPlugin, RoutingContext, RouteDecision } from '../router.js';

/**
 * One ordered rule. Every condition that is present must hold (logical AND) for
 * the rule to match; an omitted condition is simply not checked. A rule with no
 * conditions always matches.
 */
export interface RuleRouterRule {
  /** Concrete model to route to when this rule matches. */
  model: string;
  /** Per-route param overrides, surfaced as {@link RouteDecision.modelParams}. */
  modelParams?: Record<string, unknown>;
  /** Rationale surfaced in the `router_decision` event when this rule fires. */
  reason?: string;
  /** Override stickiness for this rule (default inherits {@link RouteDecision} semantics: sticky). */
  sticky?: boolean;

  /** Match only when `estimatedTokens >= minTokens`. */
  minTokens?: number;
  /** Match only when `estimatedTokens <= maxTokens`. */
  maxTokens?: number;
  /**
   * Match only when every named tool is visible in {@link RoutingContext.tools}.
   * A single name or a list (all must be present).
   */
  hasTool?: string | ReadonlyArray<string>;
  /**
   * Match when the request text (instructions + input) contains the keyword(s)
   * or matches the regex. A plain string matches case-insensitively; a list
   * matches if ANY entry matches; a `RegExp` is tested as-is.
   */
  keyword?: string | ReadonlyArray<string> | RegExp;
  /** Arbitrary predicate over the full context, AND-ed with the above. */
  when?: (ctx: RoutingContext) => boolean;
}

/** Options for {@link createRuleRouter}. */
export interface RuleRouterOptions {
  /** Router name (used in `router_decision` events and logs). Default `"rule-router"`. */
  name?: string;
  /** Pseudomodel IDs this router claims (exact match). */
  provides?: string[];
  /** Or claim dynamically; evaluated only when `provides` does not match. */
  match?: (id: string) => boolean;
  /** Ordered rules; the first whose conditions all hold wins. */
  rules: ReadonlyArray<RuleRouterRule>;
  /** Model used when no rule matches. */
  defaultModel: string;
  /** Param overrides applied to the default-model decision. */
  defaultModelParams?: Record<string, unknown>;
  /** Rationale surfaced when the default is used. */
  defaultReason?: string;
}

/** Flatten the request into a single lowercased haystack for keyword matching. */
function requestText(ctx: RoutingContext): string {
  const input = typeof ctx.input === 'string' ? ctx.input : JSON.stringify(ctx.input ?? '');
  return `${ctx.instructions}\n${input}`;
}

/** Whether the keyword condition matches the request text. */
function keywordMatches(keyword: NonNullable<RuleRouterRule['keyword']>, ctx: RoutingContext): boolean {
  const text = requestText(ctx);
  if (keyword instanceof RegExp) return keyword.test(text);
  const lower = text.toLowerCase();
  const needles = Array.isArray(keyword) ? keyword : [keyword];
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

/** Whether every named tool is present in the visible tool set. */
function toolsPresent(hasTool: NonNullable<RuleRouterRule['hasTool']>, ctx: RoutingContext): boolean {
  const wanted = Array.isArray(hasTool) ? hasTool : [hasTool];
  return wanted.every((name) => ctx.tools.includes(name));
}

/** Whether a single rule's conditions all hold for the request. */
function ruleMatches(rule: RuleRouterRule, ctx: RoutingContext): boolean {
  if (rule.minTokens !== undefined && ctx.estimatedTokens < rule.minTokens) return false;
  if (rule.maxTokens !== undefined && ctx.estimatedTokens > rule.maxTokens) return false;
  if (rule.hasTool !== undefined && !toolsPresent(rule.hasTool, ctx)) return false;
  if (rule.keyword !== undefined && !keywordMatches(rule.keyword, ctx)) return false;
  if (rule.when !== undefined && !rule.when(ctx)) return false;
  return true;
}

/**
 * Build a synchronous, rules-based {@link RouterPlugin}. The returned router
 * walks `rules` in order and resolves to the first one whose conditions all
 * hold, or to `defaultModel` when none match.
 */
export function createRuleRouter(opts: RuleRouterOptions): RouterPlugin {
  const { rules, defaultModel, defaultModelParams, defaultReason } = opts;
  return {
    name: opts.name ?? 'rule-router',
    provides: opts.provides,
    match: opts.match,
    route: (ctx): RouteDecision => {
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
