/**
 * Phase 5.7 — `skill` built-in tool.
 *
 * Surfaces the host's {@link SkillLoader} to the model behind a single
 * `skill({ name, arguments? })` call. The tool description carries a
 * `## Available Skills` listing — `(name, description + when_to_use)` triples,
 * truncated to {@link skillDescriptionBudget} chars total — so the model can
 * pick a skill without an extra `list_skills` step.
 *
 * Two execution paths:
 *
 * 1. **Inline render** (default). The skill body is run through
 *    {@link SkillLoader.render} with `arguments` shell-split, and the rendered
 *    text is returned as the tool result. The model then continues its turn
 *    with the body's content in scope as the most-recent `tool_result`.
 * 2. **`context: fork`**. When the skill's frontmatter sets `context: fork`,
 *    the render still produces the body, but instead of returning it directly
 *    the tool delegates to an injected {@link SubagentRunner} (Phase 4.7) —
 *    the body becomes the subagent's prompt, and the subagent's result text
 *    flows back as the tool result. `frontmatter.agent` chooses the subagent
 *    type; unknown types fall back to `'general-purpose'` with a warn log
 *    (graceful degradation: the alternative — throwing — would surprise a
 *    skill author who renamed an agent type out from under us).
 *
 * **Permission integration** (Phase 3.2). When the skill's frontmatter
 * defines an `allowed-tools` list, the factory composes the rules into a
 * per-invocation gate that NARROWS the run-level permission policy. The
 * narrowed gate is wired into the subagent's `allowedTools` constructor opt
 * for `context: fork` and stored on a per-render context for inline renders.
 * The `pendingSkillContext` hook below is how the agent threads the narrowed
 * policy into its `canUseTool` evaluator for the immediate post-render turn.
 */
import { z } from 'zod/v4';
import { type ToolContext } from './context.js';
import type { SkillLoader } from '../skills/loader.js';
import type { SkillInfo } from '../skills/spec.js';
import type { SubstitutionContext } from '../skills/substitution.js';
import type { SubagentRunner } from './spawn-subagent.js';
/**
 * Default fraction of the model's context window reserved for the skill
 * listing block. Mirrors Claude Code's `skillListingBudgetFraction = 0.01`.
 * Picked as 1% so a 200k-token context still spares ~2k tokens for the
 * listing — enough for ~40 short triples without crowding the prompt.
 */
export declare const DEFAULT_SKILL_DESCRIPTION_BUDGET = 0.01;
/** Result envelope returned by the `skill` tool's `execute`. */
export interface SkillToolResult {
    /** Qualified skill name that was rendered. */
    name: string;
    /** Source the skill was loaded from. */
    source: SkillInfo['source'];
    /** When the skill ran in a forked subagent, the subagent's session id. */
    subagentSessionId?: string;
    /** Rendered body OR subagent result text. */
    content: string;
    /** Set when `context: fork` and the subagent surfaced a non-success terminal status. */
    error?: string;
}
/**
 * Per-invocation overrides applied by the `skill` tool while a single skill
 * runs. The agent listens for this via {@link SkillToolOptions.onSkillActive}
 * to layer the skill's `allowed-tools` onto its `canUseTool` evaluator.
 *
 * `dispose()` clears the active context; the factory invokes it after the
 * render completes (success OR error).
 */
export interface ActiveSkillContext {
    name: string;
    allowedToolsNarrowing?: readonly string[];
    effort?: SkillInfo['frontmatter']['effort'];
    model?: string;
}
export interface SkillToolOptions {
    /** Loader the tool will resolve skills against. Required. */
    loader: SkillLoader;
    /** Substitution-context provider — called per render to build a fresh ctx. */
    buildContext: (args: readonly string[], skill: SkillInfo) => SubstitutionContext;
    /**
     * Names of skills surfaced in the listing block. Pre-computed by the agent
     * (post-budget pruning); the tool description echoes them so the model has
     * something compact to point at when it sees the system-prompt listing.
     * Unrelated to {@link SkillLoader.list} — the loader holds the full set;
     * this is just the visible-to-model subset.
     */
    visibleNames?: readonly string[];
    /**
     * Optional sink for per-render lifecycle. The agent threads its
     * `safeFireHook` here so the runtime can fire `Notification(info,
     * 'skill_loaded', { name, source })` per the spike.
     */
    onSkillLoaded?: (skill: SkillInfo) => void | Promise<void>;
    /**
     * Optional hook fired when a skill render begins (before any inline render
     * or subagent spawn). The agent installs an active-skill context that
     * narrows its `canUseTool` evaluator for the duration of the render. The
     * returned disposer is invoked after the render completes.
     */
    onSkillActive?: (ctx: ActiveSkillContext) => (() => void) | undefined;
    /**
     * Required when ANY discovered skill sets `context: fork`. The factory uses
     * this to drive the Phase 4.7 subagent runner. Omit when no fork-context
     * skills are configured — the factory falls back to inline render and
     * surfaces an `error` envelope if asked to fork.
     */
    runSubagent?: SubagentRunner;
    /** Parent session id, used to derive subagent session ids. */
    parentSessionId?: string;
    /** Default subagent depth when forking (parent depth + 1 lives in agent.ts). */
    currentSubagentDepth?: number;
    /** Optional list of registered subagent types — used to validate `frontmatter.agent`. */
    knownSubagentTypes?: readonly string[];
    /** Optional logger for skill-author surprises (unknown agent type, missing runner, …). */
    logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}
/**
 * Build the `skill` built-in tool. The factory snapshots the loader's
 * listing into the tool description at construction time — discovering a new
 * skill mid-run requires re-creating the tool (matches Claude Code's docs:
 * top-level skill dirs are scanned at session start).
 */
export declare function skillTool(opts: SkillToolOptions, ctx?: ToolContext): import("@openrouter/agent").ToolWithExecute<z.ZodObject<{
    name: z.ZodString;
    arguments: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.core.$ZodType<SkillToolResult, unknown, z.core.$ZodTypeInternals<SkillToolResult, unknown>>, Record<string, unknown>, z.core.$ZodObject<Readonly<{
    [k: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
}>, z.core.$ZodObjectConfig>>;
/**
 * Split a frontmatter `allowed-tools` string into individual rule fragments.
 * Honors the documented grammar: rules separated by whitespace, but a
 * parenthesised scoped pattern is kept atomic (so `Bash(npm run test) Read`
 * parses as two rules, not three).
 */
export declare function splitAllowedTools(raw: string): readonly string[];
/**
 * Build the `## Available Skills` listing block, dropping lowest-priority
 * entries when the projected total exceeds the budget. Drop ordering is
 * **source precedence then alphabetical** — plugin > user > project — so a
 * project skill with a long description doesn't crowd out a higher-precedence
 * user skill.
 *
 * Exported for unit tests.
 */
export declare function buildSkillListing(skills: readonly SkillInfo[], budgetChars: number): string;
//# sourceMappingURL=skill.d.ts.map