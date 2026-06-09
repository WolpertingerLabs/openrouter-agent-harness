import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { listDirectoryTool } from './list-directory.js';
import { bashTool } from './bash.js';
import { grepFilesTool } from './grep-files.js';
import { globTool } from './glob.js';
import { askUserQuestionTool } from './ask-user-question.js';
import { taskCreateTool, taskUpdateTool } from './tasks.js';
import { editNotebookTool } from './edit-notebook.js';
import { monitorTool } from './monitor.js';
import { spawnSubagentTool, spawnSubagentsTool, } from './spawn-subagent.js';
import { toolSearchTool, toolLoadTool, } from './tool-search.js';
import { skillTool } from './skill.js';
import { DEFAULT_TOOL_CONTEXT } from './context.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { listDirectoryTool } from './list-directory.js';
export { bashTool } from './bash.js';
export { grepFilesTool } from './grep-files.js';
export { globTool } from './glob.js';
export { askUserQuestionTool } from './ask-user-question.js';
export { taskCreateTool, taskUpdateTool } from './tasks.js';
export { editNotebookTool } from './edit-notebook.js';
export { monitorTool } from './monitor.js';
export { spawnSubagentTool, spawnSubagentsTool, DEFAULT_MAX_SUBAGENT_DEPTH, DEFAULT_MAX_PARALLEL_SUBAGENTS, MAX_PARALLEL_BATCH_SIZE, SPAWN_SUBAGENT_INPUT_SCHEMA, } from './spawn-subagent.js';
export { toolSearchTool, toolLoadTool, MAX_SCHEMA_PREVIEW_CHARS, SCHEMA_PREVIEW_TRUNCATION_MARKER, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, scoreMatch, tokenize, searchCatalog, buildSchemaPreview, } from './tool-search.js';
export { skillTool, splitAllowedTools, buildSkillListing, DEFAULT_SKILL_DESCRIPTION_BUDGET, } from './skill.js';
export { SERVER_TOOLS, createServerToolsHooks } from './server-tools.js';
export { DEFAULT_TOOL_CONTEXT } from './context.js';
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
export function allTools(ctx = DEFAULT_TOOL_CONTEXT, opts = {}) {
    const taskListRef = opts.taskListRef ?? { tasks: [] };
    const tools = [
        readFileTool(ctx),
        writeFileTool(ctx),
        editFileTool(ctx),
        listDirectoryTool(ctx),
        bashTool(ctx),
        grepFilesTool(ctx),
        globTool(ctx),
        askUserQuestionTool(ctx, { onAskUserQuestion: opts.onAskUserQuestion }),
        taskCreateTool(ctx, { taskListRef, onTasksChanged: opts.onTasksChanged }),
        taskUpdateTool(ctx, { taskListRef, onTasksChanged: opts.onTasksChanged }),
        editNotebookTool(ctx),
        monitorTool(ctx),
    ];
    if (opts.spawnSubagent !== undefined) {
        tools.push(spawnSubagentTool(opts.spawnSubagent, ctx));
    }
    if (opts.spawnSubagents !== undefined) {
        tools.push(spawnSubagentsTool(opts.spawnSubagents, ctx));
    }
    if (opts.toolSearch !== undefined) {
        tools.push(toolSearchTool(opts.toolSearch, ctx));
    }
    if (opts.toolLoad !== undefined) {
        tools.push(toolLoadTool(opts.toolLoad, ctx));
    }
    if (opts.skill !== undefined) {
        tools.push(skillTool(opts.skill, ctx));
    }
    return tools;
}
//# sourceMappingURL=index.js.map