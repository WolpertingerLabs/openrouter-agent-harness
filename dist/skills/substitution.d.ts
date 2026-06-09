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
import type { EffortLevel } from '../agent.js';
/** Default per-block shell timeout. Mirrors Claude Code's documented default. */
export declare const DEFAULT_SHELL_TIMEOUT_MS = 60000;
/** Literal substituted for `` !`cmd` `` blocks when policy disables shell exec. */
export declare const SHELL_DISABLED_MARKER = "[shell command execution disabled by policy]";
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
export declare function renderSkillBody(body: string, ctx: SubstitutionContext): Promise<string>;
/** {@link renderSkillBody} step 1 — `${VAR}` interpolation. Exported for tests. */
export declare function substituteVariables(body: string, ctx: SubstitutionContext): string;
/** {@link renderSkillBody} step 2 — positional / named argument substitution. */
export declare function substituteArguments(body: string, ctx: SubstitutionContext): string;
//# sourceMappingURL=substitution.d.ts.map