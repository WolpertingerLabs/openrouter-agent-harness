import type { Tool } from '@openrouter/agent';
import { type AskUserQuestionToolOptions } from './ask-user-question.js';
import { type OnTasksChanged, type TaskListRef } from './tasks.js';
import { type SpawnSubagentToolOptions, type SpawnSubagentsToolOptions } from './spawn-subagent.js';
import { type ToolSearchToolOptions, type ToolLoadToolOptions } from './tool-search.js';
import { type SkillToolOptions } from './skill.js';
import { type ToolContext } from './context.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { listDirectoryTool } from './list-directory.js';
export { bashTool } from './bash.js';
export { grepFilesTool } from './grep-files.js';
export { globTool } from './glob.js';
export { askUserQuestionTool } from './ask-user-question.js';
export type { AskUserQuestionToolOptions, AskUserQuestionToolResult, OnAskUserQuestion, UserQuestionRequest, UserQuestionResponse, } from './ask-user-question.js';
export { taskCreateTool, taskUpdateTool } from './tasks.js';
export { editNotebookTool } from './edit-notebook.js';
export type { EditNotebookResult, EditNotebookSuccess, EditNotebookError, } from './edit-notebook.js';
export { monitorTool } from './monitor.js';
export type { MonitorResult, MonitorLine, MonitorError } from './monitor.js';
export { spawnSubagentTool, spawnSubagentsTool, DEFAULT_MAX_SUBAGENT_DEPTH, DEFAULT_MAX_PARALLEL_SUBAGENTS, MAX_PARALLEL_BATCH_SIZE, SPAWN_SUBAGENT_INPUT_SCHEMA, } from './spawn-subagent.js';
export type { SpawnSubagentToolOptions, SpawnSubagentToolResult, SpawnSubagentsToolOptions, SpawnSubagentsToolResult, SpawnSubagentResultEnvelope, SubagentRunConfig, SubagentRunResult, SubagentRunner, SubagentLifecycleEmitter, } from './spawn-subagent.js';
export { toolSearchTool, toolLoadTool, MAX_SCHEMA_PREVIEW_CHARS, SCHEMA_PREVIEW_TRUNCATION_MARKER, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, scoreMatch, tokenize, searchCatalog, buildSchemaPreview, } from './tool-search.js';
export type { SearchableTool, ToolSearchMatch, ToolSearchToolResult, ToolSearchToolOptions, ToolLoadToolResult, ToolLoadToolOptions, } from './tool-search.js';
export { skillTool, splitAllowedTools, buildSkillListing, DEFAULT_SKILL_DESCRIPTION_BUDGET, } from './skill.js';
export type { SkillToolOptions, SkillToolResult, ActiveSkillContext } from './skill.js';
export type { TaskState, Task, CreateTaskRequest, UpdateTaskRequest, TaskListChangedNotification, OnTasksChanged, TaskListRef, TaskToolOptions, TaskCreateToolResult, TaskUpdateToolResult, } from './tasks.js';
export { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';
export { DEFAULT_TOOL_CONTEXT } from './context.js';
export type { ToolContext } from './context.js';
/**
 * Options accepted by {@link allTools} when constructing the bundled tool set.
 * Carries host callbacks for the interactive tools (`ask_user_question`,
 * `task_create` / `task_update`) plus the shared in-run task list ref so both
 * task factories mutate the same array.
 */
export interface AllToolsOptions {
    /** Host callback for the `ask_user_question` tool; see {@link AskUserQuestionToolOptions}. */
    onAskUserQuestion?: AskUserQuestionToolOptions['onAskUserQuestion'];
    /**
     * Convenience callback fired after every `task_create` / `task_update`
     * mutation with the full latest task list. Filtering the `Notification`
     * hook on `message === 'tasks_changed'` is equivalent.
     */
    onTasksChanged?: OnTasksChanged;
    /**
     * Shared task list both task factories mutate. Pass the same ref across
     * runs of {@link allTools} if you want a persistent list; omit to get a
     * fresh empty list per call.
     */
    taskListRef?: TaskListRef;
    /**
     * Opt-in {@link spawnSubagentTool} configuration. When omitted, the
     * `spawn_subagent` tool is **NOT** included in the default bundle —
     * subagent spawning stays an explicit, host-wired feature (mirrors
     * `OpenRouterAgentRun({ enableSubagents: true })`, which threads the
     * options struct in for the caller). Supply this to add the tool;
     * the factory needs the parent's `runSubagent` closure to drive a
     * child `OpenRouterAgentRun`. See {@link SpawnSubagentToolOptions}.
     */
    spawnSubagent?: SpawnSubagentToolOptions;
    /**
     * Phase 4.9: opt-in {@link spawnSubagentsTool} (plural) configuration.
     * When omitted, the `spawn_subagents` tool is **NOT** included in the
     * default bundle. `agent.ts` enables both `spawn_subagent` (singular)
     * and `spawn_subagents` (plural) together under the single
     * `OpenRouterAgentRun({ enableSubagents: true })` switch (the two tools
     * share a `runSubagent` closure and lifecycle emitter — wiring them
     * separately would force two near-identical opt-in flags on the host).
     * See {@link SpawnSubagentsToolOptions}.
     */
    spawnSubagents?: SpawnSubagentsToolOptions;
    /**
     * Phase 5.5: opt-in {@link toolSearchTool} configuration. When omitted,
     * the `tool_search` tool is **NOT** included in the default bundle.
     * `agent.ts` enables both `tool_search` and {@link toolLoad} together
     * under the single `OpenRouterAgentRun({ enableToolSearch: true })`
     * switch — the two tools share a catalog closure plus a `loaded` set,
     * and wiring them independently would force the host to maintain that
     * shared state. See {@link ToolSearchToolOptions}.
     */
    toolSearch?: ToolSearchToolOptions;
    /**
     * Phase 5.5: opt-in {@link toolLoadTool} configuration. Always paired
     * with {@link toolSearch}; the two are wired together under the single
     * `enableToolSearch` switch on `OpenRouterAgentRun`.
     * See {@link ToolLoadToolOptions}.
     */
    toolLoad?: ToolLoadToolOptions;
    /**
     * Phase 5.7: opt-in {@link skillTool} configuration. When set, the `skill`
     * tool is included in the default bundle with its description populated
     * from the loader's listing block. Wired by `agent.ts` whenever a
     * `skills` or `skillsDir` option is supplied to `OpenRouterAgentRun`.
     */
    skill?: SkillToolOptions;
}
/**
 * Build the default set of client tools bound to a {@link ToolContext}. Each
 * tool factory checks `ctx.signal` on entry and resolves relative path inputs
 * against `ctx.cwd`. `bash` additionally propagates SIGTERM (with a
 * 250ms SIGKILL grace) to its child process. `ask_user_question` requires
 * `opts.onAskUserQuestion` — without it the tool surfaces a
 * `no host handler registered` error from its result. `task_create` /
 * `task_update` share a single `taskListRef` (auto-created here when the
 * caller omits one).
 */
export declare function allTools(ctx?: ToolContext, opts?: AllToolsOptions): readonly Tool[];
//# sourceMappingURL=index.d.ts.map