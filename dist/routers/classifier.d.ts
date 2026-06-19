/**
 * `createClassifierRouter` — the second canonical {@link RouterPlugin} factory
 * (step 9 of `plans/autorouter-pseudomodels.md`).
 *
 * A **classifier router** resolves a pseudomodel by asking a cheap model to
 * label the request, then mapping that label to a concrete model via a supplied
 * `label → model` table. Unlike {@link createRuleRouter} it makes a network call
 * per decision, so it relies on `init()` to warm up a client once and on
 * stickiness (sticky-by-default — see `plans/autorouter-pseudomodels.md`
 * § Resolution semantics) to amortize that cost across a run: with the default
 * `sticky: true` the classification call fires once and the chosen model is
 * pinned for the rest of the run.
 *
 * **Per-decision cost.** Each non-sticky decision (or the first sticky one)
 * issues one `callModel` against {@link ClassifierRouterOptions.classifierModel}
 * (default `google/gemini-2.5-flash`). Keep the classifier model cheap and lean
 * on stickiness; set `sticky: false` only when per-turn re-routing is worth a
 * call every turn.
 *
 * **Fail-safe.** A classification that throws (network error) or whose text
 * does not name a known label falls back to {@link ClassifierRouterOptions.defaultLabel}
 * — the router always returns a concrete model and never propagates an error.
 */
import type { RouterPlugin, RoutingContext, RouterInitContext } from '../router.js';
/**
 * The narrow slice of the OpenRouter client the classifier needs: a `callModel`
 * that returns something whose `getFullResponsesStream()` yields response
 * events. Injectable via {@link ClassifierRouterOptions.createClient} so tests
 * can drive the stream the SDK would emit without a real network client.
 */
export interface ClassifierClient {
    callModel(req: Record<string, unknown>): {
        getFullResponsesStream(): AsyncIterable<unknown>;
    };
}
/** Options for {@link createClassifierRouter}. */
export interface ClassifierRouterOptions {
    /** Router name (used in `router_decision` events and logs). Default `"classifier-router"`. */
    name?: string;
    /** Pseudomodel IDs this router claims (exact match). */
    provides?: string[];
    /** Or claim dynamically; evaluated only when `provides` does not match. */
    match?: (id: string) => boolean;
    /**
     * Map from classification label to concrete model ID. The labels become the
     * candidate set offered to the classifier; the chosen label is resolved
     * through this map.
     */
    models: Record<string, string>;
    /**
     * Label used when classification fails (throws) or returns text that names no
     * known label. Must be a key of {@link ClassifierRouterOptions.models}.
     */
    defaultLabel: string;
    /** Cheap model used for the classification call. Default `google/gemini-2.5-flash`. */
    classifierModel?: string;
    /** Per-label param overrides, applied to the routed decision keyed by the chosen label. */
    modelParams?: Record<string, Record<string, unknown>>;
    /**
     * Override stickiness for every decision (default inherits {@link RouteDecision}
     * semantics: sticky). Set `false` to re-classify every turn.
     */
    sticky?: boolean;
    /**
     * Build the classification system prompt from the candidate labels. Default
     * asks the model to reply with exactly one label and nothing else.
     */
    buildInstructions?: (labels: ReadonlyArray<string>) => string;
    /**
     * Render the request into the classification input text. Default concatenates
     * the system instructions and this cycle's input.
     */
    buildInput?: (ctx: RoutingContext) => string;
    /**
     * Factory for the classification client. Defaults to a real {@link OpenRouter}
     * client built from the {@link RouterInitContext}. Override in tests to drive
     * the response stream directly.
     */
    createClient?: (ctx: RouterInitContext) => ClassifierClient;
}
/**
 * Build a {@link RouterPlugin} that classifies each request with a cheap model
 * and maps the resulting label to a concrete model. `init()` warms a client;
 * `route()` issues one classification call and resolves through the label map,
 * falling back to {@link ClassifierRouterOptions.defaultLabel} on any failure.
 */
export declare function createClassifierRouter(opts: ClassifierRouterOptions): RouterPlugin;
//# sourceMappingURL=classifier.d.ts.map