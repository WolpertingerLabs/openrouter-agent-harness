# Autorouters / Pseudomodels (Routers) — v1

**Status:** ready to implement (v1, in-memory router plugins)
**Scope:** `openrouter-agent-harness` only. callboard wiring (P3) and disk-loaded routers (v2) are out of scope for this PR.
**Owner decision (Ben, 2026-06-13):** name the concept **`routers`**; build **v1** (in-memory, first-party code); the harness **ships the two canonical factories** (`createRuleRouter`, `createClassifierRouter`).

---

## Goal

Let a caller (callboard) auto-switch the model per request using its own logic. A **pseudomodel** is a fake model ID (e.g. `auto/coding`, `router/default`) that the harness recognizes and resolves to a *real* model **just before** the request is handed to `@openrouter/agent`. The resolution runs a **router** — a code object supplied by the caller — that inspects the actual request and returns a concrete model. We are emulating an OpenRouter-style auto-router, but the routing algorithm lives in our code.

## Why a new `routers` concept (not the existing `plugins`)

The harness already has a `plugins` system (`src/plugins/spec.ts`), but it is the Claude-Code-style *directory bundle*: a manifest + skill/command roots + MCP servers + **declarative** hook configs. It is immutable, disk-loaded, takes no per-run config, executes no code of its own, and has **no path to influence the model call**. Reusing it would fight the abstraction. `routers` is a sibling, code-first concept: small code objects with lifecycle + per-router config, passed in-memory to the constructor.

## The contract (code-first)

```ts
export interface RouterPlugin {
  /** Namespace, e.g. "coding-router". Used in router_decision events and logs. */
  name: string;
  /** Pseudomodel IDs this router claims, e.g. ["auto/coding"]. */
  provides?: string[];
  /** Or claim dynamically. Evaluated only if `provides` doesn't match. */
  match?: (id: string) => boolean;
  /** Warm-up before the first turn (fetch supportedModels, build a classifier client, load a table). */
  init?: (ctx: RouterInitContext) => void | Promise<void>;
  /** Decide the concrete model for this request. */
  route: (ctx: RoutingContext) => RouteDecision | Promise<RouteDecision>;
  /** Cleanup at run end. */
  dispose?: () => void | Promise<void>;
}

export interface RoutingContext {
  pseudoModel: string;            // the fake ID requested
  defaultModel: string;           // fallback if routing fails
  sessionId: string;
  turn: number;                   // cycle index (0-based)
  phase: 'turn' | 'compaction';
  messages: ReadonlyArray<unknown>; // conversation state messages (read-only)
  input: unknown;                 // this cycle's input
  instructions: string;           // system prompt
  tools: ReadonlyArray<string>;   // visible tool names
  estimatedTokens: number;        // via serializeMessagesForEstimate
  budgetRemainingUsd?: number;
  previousModel?: string;         // what ran last turn — enables stickiness
}

export interface RouteDecision {
  model: string;                  // concrete model ID
  modelParams?: Record<string, unknown>; // optional per-route param overrides
  reason?: string;                // surfaced in router_decision event
  sticky?: boolean;               // default true: cache for the run; false = re-decide each turn
}

export interface RouterInitContext {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  logger?: AgentLogger;
}
```

Constructor option: `routers?: RouterPlugin[]`.

## Resolution semantics

- **Claim:** a model ID is a pseudomodel iff some router claims it via `provides` (exact match) or `match(id)`. Registry membership — not a prefix — is the source of truth. Recommended naming convention for IDs: `auto/…` or `router/…` (mirrors OR's `vendor/model` shape, reads in pickers, won't collide with real model IDs).
- **First claimer wins**, in array order.
- **Depth guard:** if a router resolves to *another* pseudomodel, reject past depth 1 (no pseudo→pseudo loops); fall back to default + log.
- **Fail-safe:** any thrown error in `route`/`init` → fall back to `defaultModel`, log a warning, emit the event with the fallback. A routing failure NEVER crashes the run.
- **Stickiness:** default `sticky: true` — the first decision for a pseudomodel is cached for the run and reused on later turns (protects prompt cache + cost predictability). `sticky: false` re-decides every turn. Stickiness is per-(pseudoModel, phase).

## Wiring points (grounded)

- Main turn loop: `src/agent.ts:2303–2349` — `client.callModel({ model, ... })`. Resolve immediately before; substitute `model` (and merge `modelParams` from the decision).
- Compaction pass: `src/agent.ts:1378–1392` — `callModel({ model: this.opts.model, ... })`. Resolve here too with `phase: 'compaction'`. **Fix:** `getModelContextWindow` (`src/compaction.ts:51`) is keyed on the real model — resolve the pseudomodel *before* the compaction budget math, or it silently falls to the 128k default and mis-sizes compaction.
- Lifecycle: call each router's `init()` after `Setup`/before the first `callModel`; call `dispose()` in the `finally` block (alongside the existing plugin stop bracket).

## Edge cases handled in v1

- Context-window resolution for the routed model (see compaction fix above).
- Model thrashing → sticky-by-default.
- Budget visibility via `budgetRemainingUsd` so a router can downgrade as budget depletes.
- Compaction-pass model can route to a cheap summarizer independently of the main route.
- Async routers (classifier) work because both call sites are already async.
- `modelParams` mismatch: a route may carry param overrides; if a routed model rejects e.g. `reasoning.effort`, that surfaces as a normal SDK error — documented, not silently swallowed.

## Out of scope (future)

- **v2 — disk-loaded executable routers:** let a directory-plugin manifest declare a `router: "./router.js"` entry the harness `import()`s. Enables drop-in/hot-reload but crosses a trust boundary (harness executing third-party code). Deliberate follow-up.
- **P3 — callboard wiring:** define the internal-logic router(s), register pseudomodels, expose in the model picker, render per-turn resolved model. Separate repo, separate PR.

---

## Implementation steps (execute one at a time; build + tests must pass each step)

> Note: this repo enforces a **global coverage gate** (~99.7% lines / 99.1% statements / 96.4% branches). Every new code path needs test coverage or the test/lint step fails. Spread-guards inflate branch count — plan tests accordingly.

- [x] **1. Module scaffold + types.** Create `src/router.ts` exporting the interfaces `RouterPlugin`, `RoutingContext`, `RouteDecision`, `RouterInitContext` exactly as specified above. No wiring yet. Build passes.
- [x] **2. Resolution engine.** In `src/router.ts`, implement a pure `resolveRoute(model, ctx, routers, logger)` that: finds the first claiming router (`provides` exact, else `match`); returns `null` if none claims (caller uses model as-is); calls `route()`; applies the depth-1 guard; on any throw falls back to `ctx.defaultModel`. Returns `{ resolvedModel, modelParams?, reason?, routerName, fellBack }`. Also export `isPseudoModel(model, routers)`. Full unit tests: claim-by-provides, claim-by-match, no-claim, depth guard rejection, throw→fallback.
- [x] **3. Constructor option + lifecycle.** Add `routers?: RouterPlugin[]` to `OpenRouterAgentRunOptions`; resolve/store on `ResolvedOptions`. Call each router's `init()` after the `Setup` hook and before the first `callModel`; call `dispose()` in the run's `finally` (next to the plugin-stop bracket). Tests: init/dispose fire once each, init failure is non-fatal.
- [x] **4. Stickiness cache.** Add a per-run decision cache keyed by `(pseudoModel, phase)`. First decision cached when `sticky !== false`; reused on later turns. `sticky: false` bypasses the cache. Unit tests for sticky vs per-turn behavior.
- [x] **5. Wire main callModel.** At `src/agent.ts:~2303`, if the captured `model` is a pseudomodel, build a `RoutingContext` (messages from state, current input, instructions, visible tool names, `estimatedTokens` via `serializeMessagesForEstimate`, turn index, `budgetRemainingUsd`, `previousModel`), resolve via the cache+engine, and substitute `model` + merge `modelParams` into the request. Track `previousModel`. Test via the comparative emulator: assert the emulator receives the **resolved** model, not the pseudomodel.
- [x] **6. Wire compaction callModel + context-window fix.** At `src/agent.ts:~1378`, resolve the pseudomodel with `phase: 'compaction'` and use the resolved model. Ensure the compaction-trigger `getModelContextWindow` call uses the resolved (real) model. Test: compaction sizes against the resolved model's window, not 128k default.
- [x] **7. `router_decision` event.** Add an `AgentCoreEvent` variant emitted on every resolution: `{ type: 'router_decision', pseudoModel, resolvedModel, turn, phase, reason?, routerName, fellBack }`. Export the type from `src/index.ts`. Test: event emitted on turn and compaction routes, and on fallback.
- [ ] **8. `createRuleRouter` factory.** In `src/routers/rule.ts` (or `src/router.ts`), a factory taking ordered rules over `RoutingContext` (predicates on `estimatedTokens`, tool presence, keyword/regex over instructions+input) → first matching rule's model; configurable default. Returns a `RouterPlugin`. Unit tests for each rule path + default.
- [ ] **9. `createClassifierRouter` factory.** A factory that, in `init()`, prepares a cheap-model client (configurable model, default e.g. `google/gemini-2.5-flash`), and in `route()` makes one classification call mapping the request to a label, then `label → model` from a supplied map; falls back to a default label on parse failure. Document the per-decision cost (mitigated by stickiness). Unit tests with a mocked classification call (do NOT invoke SDK callbacks directly — drive the stream events the SDK emits).
- [ ] **10. Public exports.** From `src/index.ts` export: `RouterPlugin`, `RoutingContext`, `RouteDecision`, `RouterInitContext`, `isPseudoModel`, `createRuleRouter`, `createClassifierRouter`, and the `router_decision` event type. Verify the package's type surface.
- [ ] **11. Comparative scenario.** Add a scenario under `src/__tests__/comparative/` that registers a static router for a pseudomodel and asserts end-to-end the resolved model reaches the emulated provider, including a sticky multi-turn run (model stays fixed) and a `sticky:false` run (re-decides).
- [ ] **12. Docs.** Add a "Routers / pseudomodels" section to the README: the contract, a `createRuleRouter` example, a `createClassifierRouter` example, the naming convention, and the sticky/cost notes.
