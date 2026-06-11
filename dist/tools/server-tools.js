import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
export const SERVER_TOOLS = [
    { type: 'openrouter:datetime' },
    { type: 'openrouter:web_search' },
    { type: 'openrouter:web_fetch' },
];
/** Cap on the upstream `raw` error excerpt appended to HTTP error reasons. */
const MAX_RAW_METADATA_CHARS = 500;
/**
 * Render OpenRouter's `error.metadata` (`provider_name`, `raw` upstream error)
 * as a compact `provider=…, raw=…` fragment. Empty string when the metadata is
 * absent or carries neither field. Never throws on unknown shapes.
 */
function formatErrorMetadata(metadata) {
    if (metadata === null || typeof metadata !== 'object')
        return '';
    const m = metadata;
    const parts = [];
    if (typeof m.provider_name === 'string' && m.provider_name.length > 0) {
        parts.push(`provider=${m.provider_name}`);
    }
    if (m.raw !== undefined && m.raw !== null) {
        // `metadata` is JSON.parse output, so stringify cannot throw (no cycles)
        // and cannot return undefined (raw is guarded against undefined).
        let raw = typeof m.raw === 'string' ? m.raw : JSON.stringify(m.raw);
        if (raw.length > MAX_RAW_METADATA_CHARS) {
            raw = `${raw.slice(0, MAX_RAW_METADATA_CHARS)}…[truncated]`;
        }
        if (raw.length > 0)
            parts.push(`raw=${raw}`);
    }
    return parts.join(', ');
}
export function createServerToolsHooks() {
    const hooks = new SDKHooks();
    hooks.registerBeforeCreateRequestHook({
        beforeCreateRequest(_context, input) {
            if (!input.options?.body || typeof input.options.body !== 'string')
                return input;
            try {
                const body = JSON.parse(input.options.body);
                if (Array.isArray(body.tools)) {
                    body.tools.push(...SERVER_TOOLS);
                }
                else {
                    body.tools = [...SERVER_TOOLS];
                }
                return { ...input, options: { ...input.options, body: JSON.stringify(body) } };
            }
            catch {
                return input;
            }
        },
    });
    hooks.registerAfterErrorHook({
        async afterError(_ctx, response, error) {
            // When an error object is already present, let the SDK use it as-is.
            if (error)
                return { response, error };
            // No error object means the SDK saw a non-2xx HTTP status but didn't
            // convert it to a thrown error (the default SDKHooks.afterError path
            // just returns { response, error: null } when no hooks are registered).
            // Build a meaningful Error so the failure propagates through
            // ModelResult.initStream() and surfaces in getFullResponsesStream().
            const status = response?.status ?? 0;
            let detail = response?.statusText ?? 'Unknown error';
            try {
                const rawBody = await response?.clone().text();
                if (rawBody && rawBody.length > 0) {
                    // Try to extract a human-readable message from JSON first.
                    let extracted;
                    try {
                        const parsed = JSON.parse(rawBody);
                        if (parsed && typeof parsed === 'object') {
                            const errField = parsed
                                .error;
                            const msg = errField?.message ?? parsed.message;
                            if (typeof msg === 'string' && msg.length > 0) {
                                extracted = msg;
                            }
                            // OpenRouter wraps upstream provider failures in a generic
                            // message and puts the specifics in `error.metadata`
                            // (`provider_name` + the provider's `raw` error). Append a
                            // compact rendering so the surfaced reason names the actual
                            // upstream failure, not just "Provider returned error".
                            const metaSuffix = formatErrorMetadata(errField?.metadata);
                            if (extracted !== undefined && metaSuffix.length > 0) {
                                extracted = `${extracted} [${metaSuffix}]`;
                            }
                        }
                    }
                    catch {
                        // Not valid JSON — fall through to use raw body text.
                    }
                    detail = extracted ?? rawBody;
                }
            }
            catch {
                // Keep statusText as the detail if reading the response body fails.
            }
            return {
                response,
                error: new Error(`OpenRouter request failed (${status}): ${detail}`),
            };
        },
    });
    return hooks;
}
//# sourceMappingURL=server-tools.js.map