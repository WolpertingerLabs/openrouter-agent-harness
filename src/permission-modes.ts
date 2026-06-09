import type { CanUseTool, CanUseToolResult } from './agent.js';

/**
 * Named permission preset applied to every client-tool invocation. Implemented
 * as a thin {@link CanUseTool} factory on top of the Phase 1.4 primitive — the
 * lower-level `canUseTool` constructor option still wins when both are
 * supplied.
 *
 * - `default` — read-only tools (`read_file`, `list_directory`, `grep_files`,
 *   `glob`) pass; everything else is denied with reason `'requires approval'`.
 * - `acceptEdits` — read-only + edit-style writers (`write_file`, `edit_file`)
 *   pass; `bash` is denied with reason `'requires approval'`.
 * - `bypassPermissions` — allow every tool. Equivalent to omitting the option.
 * - `plan` — strictly read-only; even edit-style writers are denied with
 *   reason `'plan mode: read-only — propose edits in your reply'`, signalling
 *   to the model that it should draft a plan rather than retry the call.
 *
 * Server-side tools (`datetime`, `web_search`, `web_fetch`) execute on
 * OpenRouter's backend and bypass `canUseTool` entirely, so no permission mode
 * can gate them.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'grep_files', 'glob'] as const;
const EDIT_TOOLS = ['write_file', 'edit_file'] as const;

const ALLOWED_BY_MODE: Record<PermissionMode, ReadonlySet<string> | null> = {
  default: new Set<string>(READ_ONLY_TOOLS),
  acceptEdits: new Set<string>([...READ_ONLY_TOOLS, ...EDIT_TOOLS]),
  plan: new Set<string>(READ_ONLY_TOOLS),
  bypassPermissions: null,
};

/**
 * Per-mode deny reason surfaced to the model via the `tool_result` payload.
 * `plan` carries copy that nudges the model toward drafting a textual plan
 * rather than retrying the blocked call; the other modes keep the canonical
 * generic phrasing. `bypassPermissions` never denies — its entry is unused
 * but present to keep the record total.
 */
const DENY_REASON_BY_MODE: Record<PermissionMode, string> = {
  default: 'requires approval',
  acceptEdits: 'requires approval',
  plan: 'plan mode: read-only — propose edits in your reply',
  bypassPermissions: '',
};

/**
 * Translate a {@link PermissionMode} into a {@link CanUseTool} closure. The
 * allow-set and deny reason are captured once per call; the returned function
 * is allocation-free per tool decision. Denials surface the canonical Phase
 * 1.4 deny shape (`{ behavior: 'deny', reason: <mode-specific text> }`),
 * which the agent's permission wrapper turns into a
 * `JSON.stringify({ error, denied: true })` tool-result payload.
 */
export function permissionModeToCanUseTool(mode: PermissionMode): CanUseTool {
  const allowed = ALLOWED_BY_MODE[mode];
  if (allowed === null) {
    return (): CanUseToolResult => ({ behavior: 'allow' });
  }
  const reason = DENY_REASON_BY_MODE[mode];
  return (toolName: string): CanUseToolResult =>
    allowed.has(toolName) ? { behavior: 'allow' } : { behavior: 'deny', reason };
}
