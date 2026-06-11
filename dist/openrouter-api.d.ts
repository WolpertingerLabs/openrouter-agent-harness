export interface AccountInfo {
    provider: 'openrouter';
    label: string;
    usageUsd: number;
    limitUsd: number | null;
}
export interface ModelInfo {
    value: string;
    displayName: string;
    description: string;
}
export declare function accountInfo(opts: {
    apiKey: string;
    baseUrl?: string;
}): Promise<AccountInfo | null>;
export declare function supportedModels(opts: {
    apiKey: string;
    baseUrl?: string;
}): Promise<ModelInfo[]>;
/**
 * Default time-to-live (ms) for a {@link ModelContextLengthCache} entry. OR's
 * `/api/v1/models` payload rarely changes a model's `context_length` mid-run,
 * so a 10-minute TTL avoids re-fetching the (large) catalogue on every
 * compaction threshold check while still picking up newly-shipped models on
 * long-lived cron sessions.
 */
export declare const MODEL_CONTEXT_LENGTH_CACHE_TTL_MS: number;
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
export declare class ModelContextLengthCache {
    #private;
    constructor(opts?: {
        ttlMs?: number;
        now?: () => number;
    });
    /**
     * Resolve the `context_length` (tokens) for `model`, fetching and caching
     * the catalogue on a cold/stale entry. The `model` id is tried verbatim and
     * with a leading `~` (OR alias marker) stripped. Returns `null` when the
     * model is unknown, the catalogue carries no `context_length` for it, or the
     * fetch failed for any reason — never throws.
     */
    get(opts: {
        model: string;
        apiKey: string;
        baseUrl?: string;
        fetchImpl?: typeof fetch;
    }): Promise<number | null>;
    /** Drop all cached entries. Primarily for tests; also lets a long-lived
     * process force a refresh after a known catalogue change. */
    clear(): void;
}
//# sourceMappingURL=openrouter-api.d.ts.map