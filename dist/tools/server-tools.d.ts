import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
/**
 * A single OpenRouter server-side tool entry, exactly as it appears in the
 * request body's `tools` array. The only required field is the `openrouter:*`
 * `type` discriminator; any additional provider/tool options ride alongside it
 * verbatim — e.g. `web_search`'s `engine` and `max_results`, or `web_fetch`
 * limits. The harness does not validate or reshape these; it forwards whatever
 * the caller supplies straight to OpenRouter.
 */
export type ServerToolConfig = {
    type: string;
} & Record<string, unknown>;
/**
 * Server tools injected when the caller supplies no {@link ServerToolConfig}
 * override: OpenRouter's datetime, web-search, and web-fetch built-ins, each
 * with their default parameters. Callers pass their own array to customize
 * options or narrow the set; an empty array disables injection entirely.
 */
export declare const DEFAULT_SERVER_TOOLS: readonly ServerToolConfig[];
export { isServerToolOutputItem, normalizeServerToolItem, type NormalizedServerTool, } from './server-tool-items.js';
export declare function createServerToolsHooks(serverTools?: readonly ServerToolConfig[]): SDKHooks;
//# sourceMappingURL=server-tools.d.ts.map