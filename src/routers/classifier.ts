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

import { OpenRouter } from '@openrouter/agent';
import { randomUUID } from 'node:crypto';

import type {
  RouterPlugin,
  RoutingContext,
  RouteDecision,
  RouterInitContext,
} from '../router.js';

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

const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-2.5-flash';

/** Default system prompt: ask for exactly one of the candidate labels. */
function defaultBuildInstructions(labels: ReadonlyArray<string>): string {
  return (
    'You are a request router. Classify the request into exactly one of these ' +
    `categories: ${labels.join(', ')}. Respond with ONLY the category name, ` +
    'nothing else.'
  );
}

/** Default classification input: system instructions plus this cycle's input. */
function defaultBuildInput(ctx: RoutingContext): string {
  const input = typeof ctx.input === 'string' ? ctx.input : JSON.stringify(ctx.input ?? '');
  return `System instructions:\n${ctx.instructions}\n\nRequest:\n${input}`;
}

/**
 * Parse the classifier's text into one of `labels`. Prefers an exact
 * (case-insensitive, trimmed) match, then a substring hit. Returns `null` when
 * no label is named so the caller can fall back to the default label.
 */
function parseLabel(text: string, labels: ReadonlyArray<string>): string | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const exact = labels.find((l) => l.toLowerCase() === normalized);
  if (exact) return exact;
  return labels.find((l) => normalized.includes(l.toLowerCase())) ?? null;
}

/** Accumulate `response.output_text.delta` text from a response event stream. */
async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const event of stream) {
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      (event as { type: unknown }).type === 'response.output_text.delta'
    ) {
      const delta = (event as { delta?: unknown }).delta;
      if (typeof delta === 'string') text += delta;
    }
  }
  return text;
}

/** Build the default OpenRouter-backed classification client from init context. */
function defaultCreateClient(ctx: RouterInitContext): ClassifierClient {
  const client = new OpenRouter({
    apiKey: ctx.apiKey,
    ...(ctx.baseUrl && { serverURL: ctx.baseUrl }),
  } as ConstructorParameters<typeof OpenRouter>[0]);
  return {
    callModel: (req) => client.callModel(req as Parameters<typeof client.callModel>[0]),
  };
}

/**
 * Build a {@link RouterPlugin} that classifies each request with a cheap model
 * and maps the resulting label to a concrete model. `init()` warms a client;
 * `route()` issues one classification call and resolves through the label map,
 * falling back to {@link ClassifierRouterOptions.defaultLabel} on any failure.
 */
export function createClassifierRouter(opts: ClassifierRouterOptions): RouterPlugin {
  const labels = Object.keys(opts.models);
  if (!(opts.defaultLabel in opts.models)) {
    throw new Error(
      `createClassifierRouter: defaultLabel "${opts.defaultLabel}" is not a key of \`models\``,
    );
  }

  const classifierModel = opts.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;
  const buildInstructions = opts.buildInstructions ?? defaultBuildInstructions;
  const buildInput = opts.buildInput ?? defaultBuildInput;
  const makeClient = opts.createClient ?? defaultCreateClient;

  let client: ClassifierClient | undefined;
  let logger: RouterInitContext['logger'];

  async function classify(ctx: RoutingContext): Promise<string> {
    if (!client) return opts.defaultLabel;
    try {
      const result = client.callModel({
        model: classifierModel,
        sessionId: `${ctx.sessionId}:classify:${randomUUID()}`,
        input: buildInput(ctx),
        instructions: buildInstructions(labels),
      });
      const text = await collectText(result.getFullResponsesStream());
      const parsed = parseLabel(text, labels);
      if (parsed === null) {
        logger?.('warn', 'Classifier returned an unrecognized label — using defaultLabel', {
          router: opts.name ?? 'classifier-router',
          pseudoModel: ctx.pseudoModel,
          text,
          defaultLabel: opts.defaultLabel,
        });
        return opts.defaultLabel;
      }
      return parsed;
    } catch (err) {
      logger?.('warn', 'Classifier call threw — using defaultLabel', {
        router: opts.name ?? 'classifier-router',
        pseudoModel: ctx.pseudoModel,
        defaultLabel: opts.defaultLabel,
        error: err instanceof Error ? err.message : String(err),
      });
      return opts.defaultLabel;
    }
  }

  return {
    name: opts.name ?? 'classifier-router',
    provides: opts.provides,
    match: opts.match,
    init: (ctx) => {
      logger = ctx.logger;
      client = makeClient(ctx);
    },
    route: async (ctx): Promise<RouteDecision> => {
      const label = await classify(ctx);
      return {
        model: opts.models[label],
        ...(opts.modelParams?.[label] !== undefined && { modelParams: opts.modelParams[label] }),
        reason: `classified as "${label}"`,
        ...(opts.sticky !== undefined && { sticky: opts.sticky }),
      };
    },
  };
}
