import { describe, it, expect, vi } from 'vitest';
import {
  allTools,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  bashTool,
  grepFilesTool,
  globTool,
  askUserQuestionTool,
  taskCreateTool,
  taskUpdateTool,
  editNotebookTool,
  monitorTool,
  type TaskListRef,
} from './index.js';

describe('tools barrel', () => {
  it('exports all twelve tools', () => {
    expect(allTools()).toHaveLength(12);
  });

  it('includes every tool by name', () => {
    const names = allTools().map((t) => t.function.name);
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_directory',
      'bash',
      'grep_files',
      'glob',
      'ask_user_question',
      'task_create',
      'task_update',
      'edit_notebook',
      'monitor',
    ]);
  });

  it('re-exports individual tool factories', () => {
    expect(readFileTool().function.name).toBe('read_file');
    expect(writeFileTool().function.name).toBe('write_file');
    expect(editFileTool().function.name).toBe('edit_file');
    expect(listDirectoryTool().function.name).toBe('list_directory');
    expect(bashTool().function.name).toBe('bash');
    expect(grepFilesTool().function.name).toBe('grep_files');
    expect(globTool().function.name).toBe('glob');
    expect(askUserQuestionTool().function.name).toBe('ask_user_question');
    expect(taskCreateTool().function.name).toBe('task_create');
    expect(taskUpdateTool().function.name).toBe('task_update');
    expect(editNotebookTool().function.name).toBe('edit_notebook');
    expect(monitorTool().function.name).toBe('monitor');
  });

  it('all tools have execute functions', () => {
    for (const t of allTools()) {
      const fn = (t.function as { execute?: unknown }).execute;
      expect(typeof fn).toBe('function');
    }
  });

  it('all tools have descriptions', () => {
    for (const t of allTools()) {
      expect(t.function.description).toBeTruthy();
    }
  });

  it('passes the same signal to every tool factory in the bundle', async () => {
    const ctrl = new AbortController();
    const tools = allTools({ cwd: '.', signal: ctrl.signal });
    ctrl.abort();
    // Every client tool's execute should reject (or resolve to a cancellation
    // payload for the well-behaved ones) once the signal aborts.
    for (const t of tools) {
      const exec = (
        t.function as { execute: (params: Record<string, unknown>) => Promise<unknown> | unknown }
      ).execute;
      // Provide a benign-enough input; the abort check runs before any IO.
      const candidate = exec(
        t.function.name === 'bash'
          ? { command: 'true' }
          : t.function.name === 'monitor'
            ? { command: 'true' }
            : t.function.name === 'ask_user_question'
              ? { question: 'q?', options: [{ label: 'A' }, { label: 'B' }] }
              : t.function.name === 'task_create'
                ? { content: 'x' }
                : t.function.name === 'task_update'
                  ? { taskId: 'nope', state: 'completed' }
                  : t.function.name === 'edit_notebook'
                    ? { path: 'nonexistent', operation: 'delete', cell_index: 0 }
                    : t.function.name === 'list_directory' ||
                        t.function.name === 'grep_files' ||
                        t.function.name === 'glob'
                      ? { path: '.', pattern: 'x', file_glob: '*', case_sensitive: true }
                      : { path: 'nonexistent', old_string: 'a', new_string: 'b', content: '' },
      );
      if (t.function.name === 'bash') {
        // bash resolves with an error result rather than throwing.
        await expect(candidate).resolves.toMatchObject({ exitCode: 1 });
      } else if (t.function.name === 'monitor') {
        // monitor resolves with a truncated empty buffer on the pre-aborted path.
        await expect(candidate).resolves.toMatchObject({
          exitCode: null,
          lines: [],
          truncated: true,
        });
      } else if (t.function.name === 'ask_user_question') {
        await expect(candidate).resolves.toEqual({ error: 'aborted' });
      } else if (t.function.name === 'task_create') {
        // Task tools do not consult ctx.signal (non-context-sensitive).
        await expect(candidate).resolves.toMatchObject({ id: expect.any(String) });
      } else if (t.function.name === 'task_update') {
        await expect(candidate).resolves.toEqual({ error: 'unknown task id: nope' });
      } else if (t.function.name === 'edit_notebook') {
        // edit_notebook does not consult ctx.signal; ENOENT path surfaces as
        // a tool-result error rather than a throw.
        await expect(candidate).resolves.toMatchObject({
          error: expect.stringMatching(/^failed to read notebook:/),
        });
      } else {
        await expect(candidate).rejects.toThrow(/cancelled/);
      }
    }
  });

  it('allTools forwards onAskUserQuestion into the ask_user_question factory', async () => {
    let received: unknown;
    const tools = allTools(
      { cwd: '.' },
      {
        onAskUserQuestion: async (req) => {
          received = req;
          return { questionId: req.questionId, selectedOptionId: 'a' };
        },
      },
    );
    const ask = tools.find((t) => t.function.name === 'ask_user_question')!;
    const exec = (
      ask.function as { execute: (params: Record<string, unknown>) => Promise<unknown> }
    ).execute;
    const result = await exec({
      question: 'pick',
      options: [{ label: 'X' }, { label: 'Y' }],
    });
    expect(received).toMatchObject({ question: 'pick' });
    expect(result).toEqual({ selectedOptionId: 'a', label: 'X' });
  });

  it('shares the taskListRef between task_create and task_update inside one allTools() bundle', async () => {
    const ref: TaskListRef = { tasks: [] };
    const onTasksChanged = vi.fn();
    const tools = allTools({ cwd: '.' }, { taskListRef: ref, onTasksChanged });
    const create = tools.find((t) => t.function.name === 'task_create')!;
    const update = tools.find((t) => t.function.name === 'task_update')!;
    const cExec = (
      create.function as { execute: (p: Record<string, unknown>) => Promise<{ id: string }> }
    ).execute;
    const uExec = (
      update.function as { execute: (p: Record<string, unknown>) => Promise<{ error?: string }> }
    ).execute;

    const { id } = await cExec({ content: 'shared' });
    const r = await uExec({ taskId: id, state: 'completed' });
    expect(r).toEqual({});
    expect(ref.tasks).toEqual([{ id, content: 'shared', state: 'completed' }]);
    // create + update each fire onTasksChanged once.
    expect(onTasksChanged).toHaveBeenCalledTimes(2);
  });

  it('forwards onTasksChanged into both task factories', async () => {
    const onTasksChanged = vi.fn();
    const tools = allTools({ cwd: '.' }, { onTasksChanged });
    const create = tools.find((t) => t.function.name === 'task_create')!;
    const cExec = (
      create.function as { execute: (p: Record<string, unknown>) => Promise<{ id: string }> }
    ).execute;
    await cExec({ content: 'x' });
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
    const tasks = onTasksChanged.mock.calls[0][0] as Array<{ content: string; state: string }>;
    expect(tasks).toMatchObject([{ content: 'x', state: 'pending' }]);
  });

  it('defaults to a fresh taskListRef when none is supplied to allTools()', async () => {
    // Two separate allTools() invocations get separate ref instances.
    const a = allTools();
    const b = allTools();
    const aCreate = (
      a.find((t) => t.function.name === 'task_create')!.function as {
        execute: (p: Record<string, unknown>) => Promise<{ id: string }>;
      }
    ).execute;
    const bUpdate = (
      b.find((t) => t.function.name === 'task_update')!.function as {
        execute: (p: Record<string, unknown>) => Promise<{ error?: string }>;
      }
    ).execute;
    const { id } = await aCreate({ content: 'isolated' });
    // The other bundle's task_update sees an empty list — id is unknown to it.
    const r = await bUpdate({ taskId: id, state: 'completed' });
    expect(r).toEqual({ error: `unknown task id: ${id}` });
  });
});
