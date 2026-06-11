/**
 * Pure helpers for OpenRouter server-tool *output items* — the response items
 * produced by tools OpenRouter executes on its own servers (`openrouter:*`),
 * as opposed to {@link ./server-tools.ts}, which builds the SDK request hooks
 * that inject those tools into the request.
 *
 * These functions have NO `@openrouter/sdk` dependency, so the agent loop can
 * import them without being affected by the `server-tools.js` mocks many tests
 * install to stub out the SDK-coupled `createServerToolsHooks`. Keep this
 * module dependency-free.
 */
/**
 * Normalized view of an OpenRouter server-tool output item, decoupled from the
 * exact SDK wire shapes (`OutputDatetimeItem`, `OutputWebSearchServerToolItem`,
 * `OutputWebFetchServerToolItem`, and any future `openrouter:*` variant). The
 * agent loop emits this as a `server_tool` {@link import('../events.js').AgentCoreEvent}
 * and persists it as a `server_tool` transcript record.
 */
export interface NormalizedServerTool {
    /** Full output-item discriminator, e.g. `"openrouter:web_search"`. */
    toolType: string;
    /** The item's `id` when the provider supplied one. */
    callId?: string;
    /** SDK `ToolCallStatus`: `"completed"` / `"in_progress"` / `"incomplete"`. */
    status: string;
    /**
     * Best-effort model-supplied input, when the item carries one. Only
     * `web_search` exposes this today (`action.query`); `datetime` / `web_fetch`
     * have no separately recoverable input, so this is omitted for them.
     */
    input?: unknown;
    /** Output payload with the envelope keys (`type` / `id` / `status`) stripped. */
    output: Record<string, unknown>;
    /** Derived failure flag — `web_fetch` `error`, or any non-`completed` status. */
    isError: boolean;
}
/**
 * True when `item` is an OpenRouter server-tool output item — i.e. its `type`
 * discriminator starts with `openrouter:`. These items are produced by tools
 * executed on OpenRouter's servers (injected via `createServerToolsHooks`),
 * arrive on the response stream as `response.output_item.done` events, and
 * never pass through the client `canUseTool` / tool-execution path.
 *
 * Narrowed to a record with a string `type` so callers can read fields off it.
 */
export declare function isServerToolOutputItem(item: unknown): item is {
    type: string;
} & Record<string, unknown>;
/**
 * Project a raw server-tool output item onto {@link NormalizedServerTool}.
 * Pure and total — never throws on unexpected shapes (unknown future tools
 * fall through to the generic envelope-stripping path).
 *
 * `isError` is derived defensively:
 *  - `web_fetch` sets a top-level `error` string on failure;
 *  - any item whose `status` is present and not `"completed"` is treated as a
 *    non-success (covers `incomplete` cancellations and forward-compat states).
 */
export declare function normalizeServerToolItem(item: {
    type: string;
} & Record<string, unknown>): NormalizedServerTool;
//# sourceMappingURL=server-tool-items.d.ts.map