const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
function buildHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
    };
}
function errorMessage(url, res) {
    return `Request to ${url} failed: ${res.status} ${res.statusText}`;
}
export async function accountInfo(opts) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/auth/key`;
    const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });
    if (res.status === 401 || res.status === 403) {
        return null;
    }
    if (!res.ok) {
        throw new Error(errorMessage(url, res));
    }
    const body = (await res.json());
    const data = body.data ?? {};
    const usage = typeof data.usage === 'number' ? data.usage : 0;
    const limit = typeof data.limit === 'number' ? data.limit : null;
    const label = typeof data.label === 'string' ? data.label : '';
    return {
        provider: 'openrouter',
        label,
        usageUsd: usage,
        limitUsd: limit,
    };
}
export async function supportedModels(opts) {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/models`;
    const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });
    if (!res.ok) {
        throw new Error(errorMessage(url, res));
    }
    const body = (await res.json());
    const entries = Array.isArray(body.data) ? body.data : [];
    return entries
        .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
        .map((m) => ({
        value: m.id,
        displayName: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
        description: typeof m.description === 'string' ? m.description : '',
    }));
}
/**
 * Default time-to-live (ms) for a {@link ModelContextLengthCache} entry. OR's
 * `/api/v1/models` payload rarely changes a model's `context_length` mid-run,
 * so a 10-minute TTL avoids re-fetching the (large) catalogue on every
 * compaction threshold check while still picking up newly-shipped models on
 * long-lived cron sessions.
 */
export const MODEL_CONTEXT_LENGTH_CACHE_TTL_MS = 10 * 60_000;
/**
 * In-memory, TTL-bounded cache for the OR `/api/v1/models` context-window
 * table. Keyed by base URL so a staging override does not poison the prod
 * cache (and vice-versa). Lookups are **failure-tolerant**: a network error,
 * non-200, or malformed body resolves to `null` rather than throwing, so the
 * caller (compaction threshold resolution) can fall back to the static table.
 * This is the explicit contract that compaction never gains a hard network
 * dependency.
 *
 * Construct one per process (the agent holds a module-level singleton) and
 * call {@link ModelContextLengthCache.get} with the run's model id. The first
 * call for a given base URL fetches the catalogue; subsequent calls within
 * the TTL are served from memory.
 */
export class ModelContextLengthCache {
    #entries = new Map();
    #ttlMs;
    #now;
    constructor(opts = {}) {
        this.#ttlMs = opts.ttlMs ?? MODEL_CONTEXT_LENGTH_CACHE_TTL_MS;
        this.#now = opts.now ?? Date.now;
    }
    /**
     * Resolve the `context_length` (tokens) for `model`, fetching and caching
     * the catalogue on a cold/stale entry. The `model` id is tried verbatim and
     * with a leading `~` (OR alias marker) stripped. Returns `null` when the
     * model is unknown, the catalogue carries no `context_length` for it, or the
     * fetch failed for any reason — never throws.
     */
    async get(opts) {
        const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
        const windows = await this.#windowsFor(baseUrl, opts.apiKey, opts.fetchImpl);
        if (!windows)
            return null;
        const direct = windows.get(opts.model);
        if (direct !== undefined)
            return direct;
        if (opts.model.startsWith('~')) {
            const aliased = windows.get(opts.model.slice(1));
            if (aliased !== undefined)
                return aliased;
        }
        return null;
    }
    async #windowsFor(baseUrl, apiKey, fetchImpl) {
        const cached = this.#entries.get(baseUrl);
        if (cached && this.#now() - cached.fetchedAt < this.#ttlMs) {
            return cached.windows;
        }
        const windows = await this.#fetchWindows(baseUrl, apiKey, fetchImpl);
        if (windows === null) {
            // Do NOT cache a failure — a transient network blip should not pin the
            // static-table fallback for the whole TTL. The next check re-attempts.
            return null;
        }
        this.#entries.set(baseUrl, { windows, fetchedAt: this.#now() });
        return windows;
    }
    async #fetchWindows(baseUrl, apiKey, fetchImpl) {
        const doFetch = fetchImpl ?? fetch;
        const url = `${baseUrl}/models`;
        try {
            const res = await doFetch(url, { headers: buildHeaders(apiKey) });
            if (!res.ok)
                return null;
            const body = (await res.json());
            const entries = Array.isArray(body.data) ? body.data : [];
            const windows = new Map();
            for (const m of entries) {
                if (typeof m?.id === 'string' &&
                    m.id.length > 0 &&
                    typeof m.context_length === 'number' &&
                    m.context_length > 0) {
                    windows.set(m.id, m.context_length);
                }
            }
            return windows;
        }
        catch {
            // Network error, abort, JSON parse failure — all collapse to the
            // static-table fallback. Compaction must never gain a hard network
            // dependency (see class JSDoc).
            return null;
        }
    }
    /** Drop all cached entries. Primarily for tests; also lets a long-lived
     * process force a refresh after a known catalogue change. */
    clear() {
        this.#entries.clear();
    }
}
//# sourceMappingURL=openrouter-api.js.map