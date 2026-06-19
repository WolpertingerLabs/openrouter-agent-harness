import { describe, it, expect } from 'vitest';
import {
  isPseudoModel,
  createRuleRouter,
  createClassifierRouter,
  type RouterPlugin,
  type RoutingContext,
  type RouteDecision,
  type RouterInitContext,
  type RouterDecisionEvent,
  type RuleRouterRule,
  type RuleRouterOptions,
  type ClassifierClient,
  type ClassifierRouterOptions,
} from './index.js';

describe('public router surface', () => {
  it('re-exports the router value bindings', () => {
    expect(typeof isPseudoModel).toBe('function');
    expect(typeof createRuleRouter).toBe('function');
    expect(typeof createClassifierRouter).toBe('function');
  });

  it('re-exports factories that produce usable RouterPlugins', () => {
    const rule: RouterPlugin = createRuleRouter({
      provides: ['auto/coding'],
      defaultModel: 'openai/gpt-4o',
      rules: [],
    });
    expect(rule.provides).toEqual(['auto/coding']);
    expect(isPseudoModel('auto/coding', [rule])).toBe(true);
    expect(isPseudoModel('openai/gpt-4o', [rule])).toBe(false);
  });

  it('exposes the router types at the type level', () => {
    // Compile-time assertions: each imported type names the expected shape.
    // The assignments are erased at runtime but fail `tsc` if an export drops.
    const ctx = {} as RoutingContext;
    const decision = {} as RouteDecision;
    const init = {} as RouterInitContext;
    const evt = {} as RouterDecisionEvent;
    const rule = {} as RuleRouterRule;
    const ruleOpts = {} as RuleRouterOptions;
    const classifier = {} as ClassifierClient;
    const classifierOpts = {} as ClassifierRouterOptions;
    expect([ctx, decision, init, evt, rule, ruleOpts, classifier, classifierOpts]).toHaveLength(8);
  });
});
