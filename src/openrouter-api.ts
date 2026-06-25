const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

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

interface AuthKeyResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
  };
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    context_length?: number;
  }>;
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
}

function errorMessage(url: string, res: Response): string {
  return `Request to ${url} failed: ${res.status} ${res.statusText}`;
}

export async function accountInfo(opts: {
  apiKey: string;
  baseUrl?: string;
}): Promise<AccountInfo | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/auth/key`;
  const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });

  if (res.status === 401 || res.status === 403) {
    return null;
  }
  if (!res.ok) {
    throw new Error(errorMessage(url, res));
  }

  const body = (await res.json()) as AuthKeyResponse;
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

export async function supportedModels(opts: {
  apiKey: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/models`;
  const res = await fetch(url, { headers: buildHeaders(opts.apiKey) });

  if (!res.ok) {
    throw new Error(errorMessage(url, res));
  }

  const body = (await res.json()) as ModelsResponse;
  const entries = Array.isArray(body.data) ? body.data : [];

  return entries
    .filter(
      (m): m is { id: string; name?: string; description?: string } =>
        typeof m?.id === 'string' && m.id.length > 0,
    )
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

interface CacheEntry {
  /** Map of model id → `context_length` (tokens). Empty on a successful but
   * model-less response; never populated on a failed fetch. */
  windows: Map<string, number>;
  fetchedAt: number;
}

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
  readonly #entries = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
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
  async get(opts: {
    model: string;
    apiKey: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }): Promise<number | null> {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const windows = await this.#windowsFor(baseUrl, opts.apiKey, opts.fetchImpl);
    if (!windows) return null;
    const direct = windows.get(opts.model);
    if (direct !== undefined) return direct;
    if (opts.model.startsWith('~')) {
      const aliased = windows.get(opts.model.slice(1));
      if (aliased !== undefined) return aliased;
    }
    return null;
  }

  async #windowsFor(
    baseUrl: string,
    apiKey: string,
    fetchImpl?: typeof fetch,
  ): Promise<Map<string, number> | null> {
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

  async #fetchWindows(
    baseUrl: string,
    apiKey: string,
    fetchImpl?: typeof fetch,
  ): Promise<Map<string, number> | null> {
    const doFetch = fetchImpl ?? fetch;
    const url = `${baseUrl}/models`;
    try {
      const res = await doFetch(url, { headers: buildHeaders(apiKey) });
      if (!res.ok) return null;
      const body = (await res.json()) as ModelsResponse;
      const entries = Array.isArray(body.data) ? body.data : [];
      const windows = new Map<string, number>();
      for (const m of entries) {
        if (
          typeof m?.id === 'string' &&
          m.id.length > 0 &&
          typeof m.context_length === 'number' &&
          m.context_length > 0
        ) {
          windows.set(m.id, m.context_length);
        }
      }
      return windows;
    } catch {
      // Network error, abort, JSON parse failure — all collapse to the
      // static-table fallback. Compaction must never gain a hard network
      // dependency (see class JSDoc).
      return null;
    }
  }

  /** Drop all cached entries. Primarily for tests; also lets a long-lived
   * process force a refresh after a known catalogue change. */
  clear(): void {
    this.#entries.clear();
  }
}
