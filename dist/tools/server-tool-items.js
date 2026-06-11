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
 * True when `item` is an OpenRouter server-tool output item — i.e. its `type`
 * discriminator starts with `openrouter:`. These items are produced by tools
 * executed on OpenRouter's servers (injected via `createServerToolsHooks`),
 * arrive on the response stream as `response.output_item.done` events, and
 * never pass through the client `canUseTool` / tool-execution path.
 *
 * Narrowed to a record with a string `type` so callers can read fields off it.
 */
export function isServerToolOutputItem(item) {
    return (item !== null &&
        typeof item === 'object' &&
        typeof item.type === 'string' &&
        item.type.startsWith('openrouter:'));
}
/** Envelope keys that describe the item shape rather than the tool's result. */
const SERVER_TOOL_ENVELOPE_KEYS = new Set(['type', 'id', 'status']);
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
export function normalizeServerToolItem(item) {
    const toolType = item.type;
    const callId = typeof item.id === 'string' ? item.id : undefined;
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const output = {};
    for (const [k, v] of Object.entries(item)) {
        if (!SERVER_TOOL_ENVELOPE_KEYS.has(k))
            output[k] = v;
    }
    // web_search carries the model's query under `action.query`. Surface it as
    // recoverable input so consumers can show "web_search: <query>"; other tools
    // expose nothing comparable, so input stays undefined for them.
    let input;
    const action = item.action;
    if (action !== null && typeof action === 'object') {
        const query = action.query;
        if (typeof query === 'string')
            input = { query };
    }
    const hasErrorField = typeof item.error === 'string';
    const isError = hasErrorField || (status.length > 0 && status !== 'completed');
    return {
        toolType,
        ...(callId !== undefined && { callId }),
        status,
        ...(input !== undefined && { input }),
        output,
        isError,
    };
}
//# sourceMappingURL=server-tool-items.js.map