import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
/**
 * Lifecycle state a task can be in. The four-state enum mirrors the host-UI
 * contract: tasks start `pending`, move to `in_progress` when the agent picks
 * them up, and end in `completed` or `cancelled`.
 */
export type TaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled';
/** A single entry in the in-run task list. */
export interface Task {
    id: string;
    content: string;
    state: TaskState;
    activeForm?: string;
}
/** Model-supplied input to `task_create`. */
export interface CreateTaskRequest {
    content: string;
    activeForm?: string;
}
/** Model-supplied input to `task_update`. */
export interface UpdateTaskRequest {
    taskId: string;
    state: TaskState;
    content?: string;
}
/**
 * Notification payload pushed on every successful `task_create` /
 * `task_update`. Subscribers receive the full latest task list (not a diff).
 */
export interface TaskListChangedNotification {
    tasks: Task[];
}
/**
 * Convenience callback fired on every mutation with the full latest list.
 * Equivalent to filtering `Notification` hook events on
 * `message === 'tasks_changed'`.
 */
export type OnTasksChanged = (tasks: Task[]) => void;
/**
 * Shared, run-scoped container holding the task list both factories mutate.
 * The agent stashes a single instance and passes it to both factories so they
 * read/write the same array across turns.
 */
export interface TaskListRef {
    tasks: Task[];
}
export interface TaskToolOptions {
    /** Shared task list both factories mutate. Defaults to a fresh empty list. */
    taskListRef?: TaskListRef;
    /** Convenience callback fired on every mutation with the full latest list. */
    onTasksChanged?: OnTasksChanged;
}
export interface TaskCreateToolResult {
    id: string;
}
export interface TaskUpdateToolResult {
    error?: string;
}
export declare function taskCreateTool(ctx?: ToolContext, opts?: TaskToolOptions): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    content: z.ZodString;
    activeForm: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.core.$ZodType<TaskCreateToolResult, unknown, z.core.$ZodTypeInternals<TaskCreateToolResult, unknown>>, Record<string, unknown>>;
export declare function taskUpdateTool(ctx?: ToolContext, opts?: TaskToolOptions): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    taskId: z.ZodString;
    state: z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        in_progress: "in_progress";
        completed: "completed";
    }>;
    content: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.core.$ZodType<TaskUpdateToolResult, unknown, z.core.$ZodTypeInternals<TaskUpdateToolResult, unknown>>, Record<string, unknown>>;
//# sourceMappingURL=tasks.d.ts.map