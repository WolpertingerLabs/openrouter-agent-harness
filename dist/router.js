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
export {};
//# sourceMappingURL=router.js.map