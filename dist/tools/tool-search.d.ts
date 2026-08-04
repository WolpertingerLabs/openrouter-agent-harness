/**
 * Phase 5.5 — `tool_search` + `tool_load` dynamic MCP tool discovery.
 *
 * When an agent run is configured with many MCP servers exposing dozens or
 * hundreds of tools, sending every tool's JSON Schema to the model on every
 * turn burns prompt budget. The opt-in `enableToolSearch` flag (see
 * {@link OpenRouterAgentRunOptions}) hides the bridge's MCP tools behind two
 * built-in tools the model invokes explicitly:
 *
 * - `tool_search({ query, limit? })` returns ranked matches from the MCP
 *   tool catalog without registering anything. Each match carries the
 *   prefixed `<serverName>__<toolName>` name, a server-name field, the
 *   tool's description, and a truncated `schema_preview` so the model can
 *   judge whether the tool is the right fit.
 * - `tool_load({ names })` registers one or more MCP tools into the run's
 *   working-set so subsequent turns can call them. Already-loaded tools are
 *   reported in a separate field; unknown names are reported as `notFound`.
 *
 * The agent wires both factories with a `getCatalog()` closure over the
 * per-run {@link McpBridge}'s tool list and an `onLoad` callback that mutates
 * the live `tools` array passed into the SDK's `callModel`. Each successful
 * load fires a `Notification` hook (`info`, `tool_loaded`) so audit
 * consumers can observe the working-set growth.
 *
 * Scorer (deterministic, hand-rolled — no deps):
 *
 * - +10 if the lowercased name CONTAINS the lowercased query
 * - +5 if the lowercased description CONTAINS the lowercased query
 * - +2 per whitespace-tokenized query word found in the name
 * - +1 per whitespace-tokenized query word found in the description
 *
 * Tie-break ascending by `name`. The substring weights dominate per-token so
 * a query that matches a name verbatim ranks above a query whose individual
 * words happen to appear in a less-relevant description. Empty queries
 * return an empty `matches` array.
 */
import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
/**
 * Max characters retained from the JSON-stringified `inputSchema` in a
 * {@link ToolSearchMatch}'s `schema_preview`. Schemas longer than this are
 * truncated and suffixed with {@link SCHEMA_PREVIEW_TRUNCATION_MARKER}. Picked
 * to be large enough to surface the top-level shape (a half-dozen keys with
 * short descriptions) but small enough that a 20-match search response
 * doesn't itself bloat the context the feature is trying to save.
 */
export declare const MAX_SCHEMA_PREVIEW_CHARS = 200;
/**
 * Single-character marker appended to a {@link ToolSearchMatch} whose
 * `schema_preview` was truncated at {@link MAX_SCHEMA_PREVIEW_CHARS}. Picked
 * as the unicode horizontal ellipsis (U+2026) rather than three dots so the
 * preview never gets misread as part of a JSON token.
 */
export declare const SCHEMA_PREVIEW_TRUNCATION_MARKER = "\u2026";
/**
 * Default `limit` applied when the model omits one. Picked to fit comfortably
 * in a single tool result (typical schemas truncate around 200 chars, so 10
 * matches ≈ 2–3 KB of result text) without forcing the model to paginate for
 * the typical "find the right tool" use case.
 */
export declare const DEFAULT_SEARCH_LIMIT = 10;
/**
 * Hard ceiling enforced on the `limit` input. The catalog itself is bounded
 * by the host's MCP configuration, so this cap mostly guards against a model
 * passing an absurd value that would dump every tool's schema preview.
 */
export declare const MAX_SEARCH_LIMIT = 50;
/**
 * Catalog entry the search index reads. Mirrors the shape the
 * {@link McpBridge} exposes on `bridge.tools`, plus a synthetic `server`
 * field derived from the prefix on `name`. The factory's `getCatalog()`
 * closure builds these from the live bridge on each call so the index
 * naturally reflects whatever subset of servers handshook successfully — a
 * server that failed init never appears, and the run continues without it.
 */
export interface SearchableTool {
    /** Prefixed name (`<serverName>__<toolName>`) as registered by the bridge. */
    name: string;
    /** Originating MCP server name (the prefix before `__`). */
    server: string;
    /** Tool description as reported by the server's `tools/list` response. */
    description?: string;
    /** Raw `inputSchema` (JSON Schema object) used to build `schema_preview`. */
    inputSchema?: unknown;
}
/**
 * A single search hit emitted from `tool_search`. The `schema_preview` is a
 * char-capped JSON stringification of the tool's `inputSchema` (see
 * {@link MAX_SCHEMA_PREVIEW_CHARS}); when the input schema was missing the
 * field is omitted entirely so the model can tell "no schema" apart from
 * "empty object schema". `score` is included so the model has signal on how
 * confident the index is in each hit — useful when two matches are tied or
 * the query is ambiguous.
 */
export interface ToolSearchMatch {
    name: string;
    server: string;
    description?: string;
    schema_preview?: string;
    score: number;
}
/**
 * Result envelope returned by `tool_search`. `note` is populated only on
 * "empty catalog" or "empty query" — non-error explanatory text the model
 * may use to recover (e.g. ask the user a clarifying question, or move on
 * without searching). Errors throw and surface as `tool_result.isError`.
 */
export interface ToolSearchToolResult {
    matches: ToolSearchMatch[];
    note?: string;
}
/**
 * Result envelope returned by `tool_load`. Each input name lands in exactly
 * one of the three buckets, so a caller can detect partial-success by
 * checking `notFound.length > 0` or `alreadyLoaded.length > 0`. The order
 * within each bucket mirrors the input array's order (de-duplicated).
 */
export interface ToolLoadToolResult {
    loaded: string[];
    alreadyLoaded: string[];
    notFound: string[];
}
/**
 * Tokenize a query string by whitespace. Lowercases, splits on `\s+`, drops
 * empty fragments. Exported so the test suite can assert tokenization
 * matches the scorer's view.
 */
export declare function tokenize(input: string): string[];
/**
 * Score a single catalog entry against a query string per the weighting
 * documented in this module's header. Exported for the unit suite — the
 * factory itself goes through {@link searchCatalog}.
 */
export declare function scoreMatch(query: string, candidate: Pick<SearchableTool, 'name' | 'description'>): number;
/**
 * Build a JSON-stringified preview of an `inputSchema`, capped at
 * {@link MAX_SCHEMA_PREVIEW_CHARS}. Returns `undefined` for a missing input
 * schema (so the match envelope can omit the field entirely instead of
 * advertising an empty preview). A schema that cannot be JSON-serialized
 * (e.g. cyclic) falls back to its `toString()` representation rather than
 * throwing — the preview is best-effort.
 */
export declare function buildSchemaPreview(inputSchema: unknown): string | undefined;
/**
 * Run the scorer against every catalog entry, drop zero-score entries,
 * sort by descending score with a name-ascending tie-break, slice to
 * `limit`, and project to {@link ToolSearchMatch}. Pure — exported so the
 * test suite can exercise the ranking deterministically without spinning
 * up an agent.
 */
export declare function searchCatalog(catalog: readonly SearchableTool[], query: string, limit: number): ToolSearchMatch[];
/**
 * Factory inputs for {@link toolSearchTool}.
 *
 * - `getCatalog` is invoked on every search call and must return the current
 *   MCP tool catalog. The agent supplies a closure over the per-run
 *   {@link McpBridge}'s `tools` getter so server-init failures naturally
 *   shrink the catalog without further bookkeeping.
 */
export interface ToolSearchToolOptions {
    getCatalog: () => readonly SearchableTool[];
}
/**
 * Build the `tool_search` built-in tool. The factory takes a `getCatalog()`
 * closure (not a snapshot) so the catalog is read fresh on every call — the
 * agent's bridge tool set is fixed for the life of a single run, but reading
 * lazily keeps the factory honest about that contract (and lets the
 * integration test stub the catalog mid-run).
 */
export declare function toolSearchTool(opts: ToolSearchToolOptions, _ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.core.$ZodType<ToolSearchToolResult, unknown, z.core.$ZodTypeInternals<ToolSearchToolResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
/**
 * Factory inputs for {@link toolLoadTool}. The agent wires:
 *
 * - `getCatalog` — same closure as {@link toolSearchTool}, so the load check
 *   sees the same set of names the search exposed.
 * - `isLoaded(name)` — runtime predicate returning whether the given prefixed
 *   name is already in the run's working set. The agent backs this with a
 *   shared `Set<string>`.
 * - `onLoad(name, server)` — invoked once per successfully-loaded name (NOT
 *   for `alreadyLoaded` or `notFound` entries). The agent's wiring mutates
 *   the live `toolsForRun` array so the SDK's next-turn tool-list build
 *   picks the new entry up, and fires the audit `Notification`.
 */
export interface ToolLoadToolOptions {
    getCatalog: () => readonly SearchableTool[];
    isLoaded: (name: string) => boolean;
    onLoad: (name: string, server: string) => void | Promise<void>;
}
/**
 * Build the `tool_load` built-in tool. Loading is the only side effect: the
 * tool itself returns the bucketed result (`loaded` / `alreadyLoaded` /
 * `notFound`) and otherwise leaves the agent's state untouched. Duplicate
 * names within a single call are coalesced — the second occurrence lands in
 * `alreadyLoaded` rather than triggering a second `onLoad` call.
 */
export declare function toolLoadTool(opts: ToolLoadToolOptions, _ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    names: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.core.$ZodType<ToolLoadToolResult, unknown, z.core.$ZodTypeInternals<ToolLoadToolResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
//# sourceMappingURL=tool-search.d.ts.map