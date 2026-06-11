import { SDKHooks } from '@openrouter/sdk/hooks/hooks';
export declare const SERVER_TOOLS: ({
    type: "openrouter:datetime";
} | {
    type: "openrouter:web_search";
} | {
    type: "openrouter:web_fetch";
})[];
export { isServerToolOutputItem, normalizeServerToolItem, type NormalizedServerTool, } from './server-tool-items.js';
export declare function createServerToolsHooks(): SDKHooks;
//# sourceMappingURL=server-tools.d.ts.map