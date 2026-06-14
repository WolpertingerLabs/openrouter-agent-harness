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
 * Step 1 of `plans/autorouter-pseudomodels.md` defines only the type surface;
 * the resolution engine, lifecycle wiring, and canonical factories land in
 * later steps.
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
