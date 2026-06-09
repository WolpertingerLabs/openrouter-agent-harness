/**
 * Phase 5.7 — shared substitution helper used when a skill body is rendered.
 *
 * Substitution runs ONCE over the raw body, in this order:
 *
 * 1. `${VAR}` interpolation — the well-known `CLAUDE_*` keys plus user-config
 *    (`user_config.<key>`) and generic env passthrough via `ctx.env`.
 * 2. Positional arguments — `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (1-indexed),
 *    `$<name>` (when `ctx.named` is set).
 * 3. Inline shell — `` !`<command>` `` — POSITION-RESTRICTED: only matched at
 *    the start of a line OR immediately after whitespace. NOT matched after
 *    non-whitespace characters (matches Claude Code's documented behaviour).
 * 4. Fenced multi-line shell — ` ```! ` opens a block, ` ``` ` closes it.
 *    Same execution semantics as inline blocks.
 *
 * The output is **not re-scanned** — substituted content is treated as literal
 * markdown in the rendered body. This prevents command-output injection from
 * accidentally triggering further substitution (Claude Code parity).
 *
 * Shell execution uses {@link node:child_process.spawn} directly (NOT routed
 * through the `bash` tool); it respects:
 *
 * - {@link SubstitutionContext.signal} — aborting the run kills the child via
 *   SIGTERM, then SIGKILL after a 250ms grace window (parity with
 *   `bash.ts`).
 * - {@link SubstitutionContext.timeoutMs} — defaults to {@link DEFAULT_SHELL_TIMEOUT_MS}
 *   (60s); per-block override is not yet exposed in the frontmatter.
 * - {@link SubstitutionContext.disableShellExecution} — when `true`, replaces
 *   every command with the literal `[shell command execution disabled by policy]`
 *   string instead of spawning anything.
 */

import { spawn } from 'node:child_process';
import type { EffortLevel } from '../agent.js';

/** Default per-block shell timeout. Mirrors Claude Code's documented default. */
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

/** SIGTERM → SIGKILL grace window. Matches `bash.ts`. */
const KILL_GRACE_MS = 250;

/** Literal substituted for `` !`cmd` `` blocks when policy disables shell exec. */
export const SHELL_DISABLED_MARKER = '[shell command execution disabled by policy]';

/**
 * Context handed to {@link renderSkillBody}. Carries the positional / named
 * argument arrays, the well-known `CLAUDE_*` paths, the abort + timeout
 * controls, and the policy switch for shell execution.
 *
 * **Caller-decides invariant** — environment values come from `ctx.env`
 * (caller-supplied), NOT from `process.env`. This keeps `src/` free of
 * `process.env.*` reads.
 */
export interface SubstitutionContext {
  /** Positional CLI-style arguments. Already shell-split by the caller. */
  arguments: readonly string[];
  /** Named positional bindings (from `arguments:` frontmatter); referenced as `$<name>`. */
  named?: Readonly<Record<string, string>>;
  /** Current session id — `${CLAUDE_SESSION_ID}`. */
  sessionId: string;
  /** Current effort level — `${CLAUDE_EFFORT}`. Omitted → expansion yields the literal `${CLAUDE_EFFORT}`. */
  effort?: EffortLevel;
  /** Absolute path to the dir containing this skill's `SKILL.md` — `${CLAUDE_SKILL_DIR}`. */
  skillDir?: string;
  /** Absolute path to the owning plugin root (5.8) — `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string;
  /** Absolute path to the plugin's data dir (5.8 v2) — `${CLAUDE_PLUGIN_DATA}`. */
  pluginData?: string;
  /** Project / repo root — `${CLAUDE_PROJECT_DIR}`. */
  projectDir: string;
  /** Per-plugin user config — `${user_config.<key>}`. */
  userConfig?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Environment-variable map. Generic `${ENV_NAME}` substitution reads from
   * here when the name is not one of the well-known `CLAUDE_*` keys. Keep this
   * narrow — passing the full `process.env` makes the rendered body leak host
   * env to the model; supply only the entries the skill explicitly needs.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Working directory for shell execution. Defaults to {@link projectDir} when
   * unset.
   */
  cwd?: string;
  /** Composite abort signal. Aborting it propagates SIGTERM/SIGKILL to children. */
  signal?: AbortSignal;
  /** Per-block timeout (ms). Defaults to {@link DEFAULT_SHELL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** When `true`, every `` !`cmd` `` block becomes {@link SHELL_DISABLED_MARKER}. */
  disableShellExecution?: boolean;
}

/**
 * One-pass render of a SKILL.md body. Synchronous transformations happen
 * upfront; shell execution is awaited per block in document order. Substituted
 * output is NOT re-scanned for placeholders — matches Claude Code's documented
 * behaviour and avoids the obvious injection vector where command stdout
 * carries a `$N` or `` !`cmd` `` of its own.
 *
 * Order of operations:
 * 1. `${VAR}` interpolation (well-known keys → ctx fields → `user_config.*` →
 *    generic `env[VAR]` → pass through `${UNKNOWN}` unchanged).
 * 2. Positional/named arguments (`$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`).
 * 3. Inline `` !`cmd` `` execution.
 * 4. Fenced ` ```! ` block execution.
 *
 * The shell-block steps are last so positional arguments interpolated into
 * commands by the caller (via `${env.X}`) survive into the spawn invocation,
 * but command stdout is NOT scanned for nested placeholders.
 */
export async function renderSkillBody(body: string, ctx: SubstitutionContext): Promise<string> {
  let out = body;
  out = substituteVariables(out, ctx);
  out = substituteArguments(out, ctx);
  // Single combined shell pass — fenced + inline patterns share one regex
  // (alternation) so their outputs are NOT re-scanned. Re-scanning would
  // let command stdout that happens to contain ``` ` or `` !`...` `` trigger
  // further execution; Claude Code documents shell substitution as
  // single-pass.
  out = await substituteShell(out, ctx);
  return out;
}

/** {@link renderSkillBody} step 1 — `${VAR}` interpolation. Exported for tests. */
export function substituteVariables(body: string, ctx: SubstitutionContext): string {
  // Match `${...}` where the contents are simple identifier-style names
  // (letters/digits/underscore, plus a single `.` for `user_config.KEY`).
  // Anything more exotic (spaces, operators, function calls) passes through.
  return body.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (full, name: string) => {
    const resolved = resolveVariable(name, ctx);
    return resolved ?? full;
  });
}

function resolveVariable(name: string, ctx: SubstitutionContext): string | undefined {
  // Well-known keys first.
  switch (name) {
    case 'CLAUDE_SESSION_ID':
      return ctx.sessionId;
    case 'CLAUDE_PROJECT_DIR':
      return ctx.projectDir;
    case 'CLAUDE_SKILL_DIR':
      return ctx.skillDir;
    case 'CLAUDE_EFFORT':
      return ctx.effort;
    case 'CLAUDE_PLUGIN_ROOT':
      return ctx.pluginRoot;
    case 'CLAUDE_PLUGIN_DATA':
      return ctx.pluginData;
  }
  // user_config.<key>
  if (name.startsWith('user_config.')) {
    const key = name.slice('user_config.'.length);
    const raw = ctx.userConfig?.[key];
    if (raw === undefined) return undefined;
    return String(raw);
  }
  // Generic env passthrough.
  return ctx.env?.[name];
}

/** {@link renderSkillBody} step 2 — positional / named argument substitution. */
export function substituteArguments(body: string, ctx: SubstitutionContext): string {
  const args = ctx.arguments;
  const named = ctx.named ?? {};

  // Did the ORIGINAL body reference args in any form? If so, the runtime
  // skips the "append ARGUMENTS: ... at the bottom" fallback. Detection
  // happens up front so it survives the later replacement passes.
  const referencedArgs =
    /\$ARGUMENTS(?:\b|\[)/.test(body) ||
    /\$\d+\b/.test(body) ||
    Object.keys(named).some((n) => new RegExp(`\\$${n}\\b`).test(body));

  // $ARGUMENTS[N] — explicit indexed access, 0-based, mirrors Claude Code.
  let out = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_full, raw: string) => {
    const idx = Number.parseInt(raw, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= args.length) return '';
    return args[idx]!;
  });

  // $ARGUMENTS — the entire arg list joined by single spaces.
  out = out.replace(/\$ARGUMENTS\b/g, args.join(' '));

  // $<N> — positional, 1-indexed (so `$1` is the first arg) per shell-style
  // convention. `$0` is reserved for the skill name and is left to the
  // caller to set in `ctx.named` if they want it; matches what users expect.
  out = out.replace(/\$(\d+)\b/g, (_full, raw: string) => {
    const idx = Number.parseInt(raw, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > args.length) return '';
    return args[idx - 1]!;
  });

  // $<name> — named positional. Restricted to identifier-style names so we
  // don't accidentally swallow `$ARGUMENTS` (already handled above) or env
  // sigils in shell snippets.
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (full, name: string) => {
    if (name === 'ARGUMENTS') return full; // already processed
    if (name in named) return named[name]!;
    return full;
  });

  if (!referencedArgs && args.length > 0) {
    out += `\n\nARGUMENTS: ${args.join(' ')}`;
  }

  return out;
}

/**
 * Combined fenced + inline shell pass. Fenced fences (` ```! ... ``` `) take
 * precedence over inline `` !`cmd` `` when both could match a region — the
 * fenced regex is wider so we test it first per match position.
 *
 * Single regex with alternation; matches are processed in document order and
 * their substituted output is NOT re-scanned (it lands in the output buffer
 * and never re-enters the matcher). When `ctx.disableShellExecution` is
 * `true`, no `spawn` happens — the marker string is substituted in place.
 */
async function substituteShell(body: string, ctx: SubstitutionContext): Promise<string> {
  // Group 1 = fenced opener leading newline-or-empty, group 2 = fence indent,
  //   group 3 = fenced command body.
  // Group 4 = inline leading boundary (start-of-line or whitespace),
  //   group 5 = inline command body.
  const pattern = /(^|\n)([ \t]*)```!\n([\s\S]*?)\n[ \t]*```|(^|[\s])!`([^`]+)`/g;
  let out = '';
  let last = 0;
  pattern.lastIndex = 0;
  for (;;) {
    const m = pattern.exec(body);
    if (!m) break;
    out += body.slice(last, m.index);
    const fencedLead = m[1];
    const fencedIndent = m[2];
    const fencedCmd = m[3];
    const inlineLead = m[4];
    const inlineCmd = m[5];
    if (fencedCmd !== undefined) {
      out += fencedLead ?? '';
      if (ctx.disableShellExecution) {
        out += `${fencedIndent ?? ''}${SHELL_DISABLED_MARKER}`;
      } else {
        const result = await runShellBlock(fencedCmd, ctx);
        const indent = fencedIndent ?? '';
        const indented = result
          .split('\n')
          .map((line) => `${indent}${line}`)
          .join('\n');
        out += indented;
      }
    } else if (inlineCmd !== undefined) {
      out += inlineLead ?? '';
      if (ctx.disableShellExecution) {
        out += SHELL_DISABLED_MARKER;
      } else {
        out += await runShellBlock(inlineCmd, ctx);
      }
    }
    last = m.index + m[0].length;
  }
  out += body.slice(last);
  return out;
}

/**
 * Spawn a single `sh -c` invocation and return its stdout (stderr is captured
 * but appended to the result on a non-zero exit, so the model can see why the
 * command failed without the run blowing up).
 *
 * Direct `spawn` (not the `bash` tool) — `bash` is bounded to
 * tool-call accounting and would surface the call as a separate tool result in
 * the SDK stream. Inline substitution is host-internal: the command output
 * folds into the rendered body BEFORE the model sees it.
 */
function runShellBlock(command: string, ctx: SubstitutionContext): Promise<string> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const cwd = ctx.cwd ?? ctx.projectDir;
  return new Promise<string>((resolveResult) => {
    if (ctx.signal?.aborted) {
      resolveResult(formatExitFailure('aborted', '', ''));
      return;
    }
    const child = spawn('sh', ['-c', command], { cwd });
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    let cancelled = false;

    const onTimeout = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    };
    const timeoutTimer = setTimeout(onTimeout, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (text: string): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      resolveResult(text);
    };

    child.on('error', (err) => {
      finish(formatExitFailure(`spawn error: ${err.message}`, stdout, stderr));
    });

    child.on('close', (code, killSignal) => {
      if (cancelled) {
        finish(formatExitFailure('aborted', stdout, stderr));
        return;
      }
      if (killSignal === 'SIGTERM' || killSignal === 'SIGKILL') {
        finish(formatExitFailure(`terminated by ${killSignal}`, stdout, stderr));
        return;
      }
      if (code !== 0) {
        finish(formatExitFailure(`exit code ${code ?? 'unknown'}`, stdout, stderr));
        return;
      }
      // Strip a single trailing newline so the rendered body reads cleanly —
      // matches what users expect from a `$(cmd)` shell expansion.
      const trimmed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
      finish(trimmed);
    });
  });
}

function formatExitFailure(reason: string, stdout: string, stderr: string): string {
  const parts = [`[shell ${reason}]`];
  if (stdout) parts.push(stdout.trimEnd());
  if (stderr) parts.push(`stderr: ${stderr.trimEnd()}`);
  return parts.join('\n');
}
