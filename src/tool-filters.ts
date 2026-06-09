import type { CanUseTool, CanUseToolResult } from './agent.js';
import { compileGlobToRegex } from './utils/glob.js';

/**
 * Heuristic for the prefixed-tool-name shape emitted by the MCP bridge:
 * `<serverName>__<toolName>`. Anchored to the literal `MCP_TOOL_NAME_SEPARATOR`
 * (`__`) used by `src/mcp/bridge.ts`. Kept inline so this module has no
 * runtime dependency on the bridge.
 */
function isMcpPrefixedToolName(name: string): boolean {
  const idx = name.indexOf('__');
  return idx > 0 && idx < name.length - 2;
}

/**
 * Accepts both Claude-SDK-style friendly names (`Bash`, `Edit`, ...) and the
 * library's canonical tool names (`bash`, `edit_file`, ...). Either form
 * resolves to a single canonical name used internally. The legacy
 * `run_command` spelling is still accepted as an alias for `bash`.
 */
const TOOL_NAME_LOOKUP: Readonly<Record<string, string>> = {
  Bash: 'bash',
  Edit: 'edit_file',
  Write: 'write_file',
  Read: 'read_file',
  List: 'list_directory',
  Grep: 'grep_files',
  bash: 'bash',
  run_command: 'bash',
  edit_file: 'edit_file',
  write_file: 'write_file',
  read_file: 'read_file',
  list_directory: 'list_directory',
  grep_files: 'grep_files',
};

/**
 * Per-tool argument key used by scoped rule matching — the field of the tool
 * input that the rule's pattern is tested against. Keep in sync with each
 * tool's input schema.
 */
const ARG_KEY_BY_TOOL: Readonly<Record<string, string>> = {
  bash: 'command',
  edit_file: 'path',
  write_file: 'path',
  read_file: 'path',
  list_directory: 'path',
  grep_files: 'pattern',
};

export interface CompiledRule {
  /** Canonical tool name the rule targets. */
  toolName: string;
  /** True when this rule applies to the given tool input. */
  matches: (input: unknown) => boolean;
}

function compileBashPattern(pattern: string): RegExp {
  // Bash patterns are opaque command-string matchers: only `*` is a wildcard
  // (matches any chars, including spaces). Anchored at both ends; all other
  // regex metacharacters are escaped so `npm run -- --foo` matches literally.
  const body = pattern
    .split('*')
    .map((s) => s.replace(/[.+^${}()|[\]\\?/]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + '$');
}

/**
 * Compile a single `allowedTools` / `disallowedTools` entry into a
 * {@link CompiledRule}.
 *
 * Grammar:
 * - Plain name: `'read_file'` or `'Read'` — matches every invocation of that tool.
 * - Scoped: `'<ToolName>(<pattern>)'` — pattern tested against a tool-specific
 *   argument (Bash → `command`, Edit/Write/Read/List → `path`, Grep →
 *   `pattern`). Bash patterns use `*` as a wildcard; the others are
 *   path-style globs (`*` excludes `/`, `**` spans directories).
 *
 * Throws on malformed input (missing closing paren, empty pattern, unknown
 * tool name) — validation is eager so callers see the error at construction.
 */
export function compileRule(rule: string): CompiledRule {
  if (typeof rule !== 'string') {
    throw new Error(`Invalid tool filter rule: expected string, got ${typeof rule}`);
  }
  const trimmed = rule.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid tool filter rule: empty string`);
  }
  const parenIdx = trimmed.indexOf('(');
  if (parenIdx === -1) {
    const canonical = TOOL_NAME_LOOKUP[trimmed];
    if (canonical) {
      return { toolName: canonical, matches: () => true };
    }
    // Phase 5.2.4: accept MCP-prefixed names verbatim. These are emitted by
    // the bridge as `<serverName>__<toolName>` and are not in the static
    // lookup. Scoped patterns are NOT supported for MCP tools (we don't know
    // which input key to match against).
    if (isMcpPrefixedToolName(trimmed)) {
      return { toolName: trimmed, matches: () => true };
    }
    throw new Error(
      `Invalid tool filter rule "${rule}": unknown tool name "${trimmed}". ` +
        `Valid names: ${Object.keys(TOOL_NAME_LOOKUP).join(', ')}. ` +
        `MCP tools (e.g. "<server>__<tool>") are also accepted as plain names.`,
    );
  }
  if (!trimmed.endsWith(')')) {
    throw new Error(`Invalid tool filter rule "${rule}": missing closing parenthesis.`);
  }
  const friendly = trimmed.slice(0, parenIdx).trim();
  const pattern = trimmed.slice(parenIdx + 1, -1);
  if (friendly.length === 0) {
    throw new Error(`Invalid tool filter rule "${rule}": missing tool name before "(".`);
  }
  if (pattern.length === 0) {
    throw new Error(`Invalid tool filter rule "${rule}": empty pattern between parentheses.`);
  }
  const canonical = TOOL_NAME_LOOKUP[friendly];
  if (!canonical) {
    throw new Error(
      `Invalid tool filter rule "${rule}": unknown tool name "${friendly}". ` +
        `Valid names: ${Object.keys(TOOL_NAME_LOOKUP).join(', ')}.`,
    );
  }
  const argKey = ARG_KEY_BY_TOOL[canonical];
  // Unreachable in practice — every entry in TOOL_NAME_LOOKUP has a matching
  // ARG_KEY_BY_TOOL row — but the throw keeps the type guard honest.
  if (!argKey) {
    throw new Error(
      `Invalid tool filter rule "${rule}": tool "${canonical}" does not support scoped patterns.`,
    );
  }
  const regex =
    canonical === 'bash' ? compileBashPattern(pattern) : compileGlobToRegex(pattern);
  return {
    toolName: canonical,
    matches: (input: unknown): boolean => {
      if (typeof input !== 'object' || input === null) return false;
      const value = (input as Record<string, unknown>)[argKey];
      if (typeof value !== 'string') return false;
      return regex.test(value);
    },
  };
}

export interface ToolFilterParams {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * Optional fallback gate consulted when neither the allow nor deny list
   * matches a given tool call — typically the {@link permissionModeToCanUseTool}
   * closure derived from a {@link PermissionMode}.
   */
  modeGate?: CanUseTool;
}

/**
 * Compose `allowedTools` / `disallowedTools` into a single {@link CanUseTool}.
 *
 * Resolution order per call:
 * 1. Any matching `disallowedTools` rule → deny (deny wins).
 * 2. Any matching `allowedTools` rule → allow.
 * 3. `modeGate` (if supplied) decides.
 * 4. Otherwise → allow (matches the library's "no gating" backward-compat default).
 *
 * Rules are compiled eagerly — malformed input throws at this call site, not
 * later at first use.
 */
export function buildToolFilterCanUseTool(params: ToolFilterParams): CanUseTool {
  const allowed = (params.allowedTools ?? []).map(compileRule);
  const disallowed = (params.disallowedTools ?? []).map(compileRule);
  const modeGate = params.modeGate;
  return async (toolName, input, ctx): Promise<CanUseToolResult> => {
    for (const rule of disallowed) {
      if (rule.toolName === toolName && rule.matches(input)) {
        return { behavior: 'deny', reason: `denied by disallowedTools` };
      }
    }
    for (const rule of allowed) {
      if (rule.toolName === toolName && rule.matches(input)) {
        return { behavior: 'allow' };
      }
    }
    if (modeGate) {
      return modeGate(toolName, input, ctx);
    }
    return { behavior: 'allow' };
  };
}
