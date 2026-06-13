import { tool } from '@openrouter/agent';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TOOL_CONTEXT, type ToolContext } from './context.js';
import type {
  AgentCoreEventStatus,
  HookEvent,
  HookPayload,
  SubagentResultSummary,
  TokenUsage,
} from '../events.js';
import type { PermissionMode } from '../permission-modes.js';
import type { EffortLevel } from '../agent.js';
import type { AnthropicCacheControlDirective } from '@openrouter/sdk/models';
import type { ServerToolConfig } from './server-tools.js';

/**
 * Phase 5.4: tuple of accepted effort enum values. Defined here so the Zod
 * schemas on both `spawn_subagent` and `spawn_subagents` share a single source
 * of truth for the OR `reasoning.effort` enum. Mirrors the values in the
 * {@link EffortLevel} type alias on `OpenRouterAgentRunOptions`.
 */
export const EFFORT_VALUES = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const;

/**
 * Default cap on the subagent chain depth (root counts as `0`). With the
 * default, `spawn_subagent` is allowed from runs at depth `0`, `1`, and `2`,
 * and rejects from depth `3` onward — yielding a chain of at most three
 * levels (parent → sub → sub-sub → reject 4th).
 *
 * Tunable per-run via `OpenRouterAgentRunOptions.maxSubagentDepth`.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/**
 * Phase 4.9: default cap on the number of subagents that may be in-flight at
 * once for a single `spawn_subagents` (plural) invocation. Tunable per-run
 * via `OpenRouterAgentRunOptions.maxParallelSubagents`. The pool submits
 * subagents in submission order; results are returned in submission order
 * regardless of completion order.
 */
export const DEFAULT_MAX_PARALLEL_SUBAGENTS = 4;

/**
 * Phase 4.9: schema-level ceiling on the array length accepted by the
 * `spawn_subagents` tool's input. Hard cap to prevent the model from
 * accidentally fanning out an unbounded list; the concurrency pool
 * ({@link DEFAULT_MAX_PARALLEL_SUBAGENTS}) caps in-flight subagents
 * separately. Picked to be comfortably larger than the default pool size
 * (4×) so a typical fan-out has headroom without inviting runaway batches.
 */
export const MAX_PARALLEL_BATCH_SIZE = 16;

/**
 * Config the {@link SubagentRunner} closure receives from the
 * `spawn_subagent` tool's execute. Carries the prompt + optional restrictions
 * already parsed/validated from the model's tool input, plus the composite
 * abort signal and the chain depth the new run should run at.
 */
export interface SubagentRunConfig {
  sessionId: string;
  prompt: string;
  instructions?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Optional whitelist of tool names — subagent's pool narrows to these only. */
  toolNames?: readonly string[];
  /**
   * Phase 4.8: per-subagent overrides. Each field, when set, REPLACES the
   * corresponding parent-resolved value on the child run's constructor args
   * (override wins; child does not COMPOSE with the parent's filters). When
   * omitted, the runner falls back to the parent's already-resolved value.
   */
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * Pass-through to {@link OpenRouterAgentRunOptions.effort}. Phase 5.4
   * wired this through to the child's `callModel` call as
   * `reasoning: { effort }`.
   */
  effort?: EffortLevel;
  /**
   * Pass-through to {@link OpenRouterAgentRunOptions.cacheControl}. OR auto
   * prompt-cache directive forwarded to the child run's `callModel` request
   * body as the top-level `cacheControl` field. Omit to inherit the
   * parent's value (or to leave unset if the parent also omitted it).
   * Only honored by Anthropic Claude models today.
   */
  cacheControl?: AnthropicCacheControlDirective;
  /**
   * Pass-through to {@link OpenRouterAgentRunOptions.serverTools}. Each entry
   * is forwarded verbatim into the child's request bodies; `[]` suppresses
   * server-tool injection. Omit to inherit the parent's value.
   */
  serverTools?: readonly ServerToolConfig[];
  /** Composite abort signal that fires when either the parent or the subagent itself aborts. */
  signal: AbortSignal;
  /** Chain depth of the new subagent (root = 0, first subagent = 1, …). */
  depth: number;
}

/**
 * Result envelope handed back to the `spawn_subagent` tool by the runner.
 * Shape-identical to {@link SubagentResultSummary} — the runner drains the
 * subagent's event stream and produces this summary.
 */
export type SubagentRunResult = SubagentResultSummary;

/**
 * Closure injected at factory construction time. Builds and drives a new
 * `OpenRouterAgentRun` for the subagent, drains its event stream, and
 * resolves with the captured summary. The factory itself stays free of any
 * dependency on `agent.ts` (no import cycle).
 */
export type SubagentRunner = (config: SubagentRunConfig) => Promise<SubagentRunResult>;

/**
 * Lifecycle-emitter signature used by the factory to fire `SubagentStart`
 * and `SubagentEnd` on the parent's `onHook`. Wired by `agent.ts` to forward
 * straight into the run's `safeFireHook`. Optional — when omitted, the
 * `spawn_subagent` tool still works, but `SubagentStart`/`SubagentEnd` are
 * dropped (the inherited per-event hooks on the subagent itself still fire).
 */
export type SubagentLifecycleEmitter = (
  event: Extract<HookEvent, 'SubagentStart' | 'SubagentEnd'>,
  payload: Extract<HookPayload, { event: 'SubagentStart' | 'SubagentEnd' }>,
) => void | Promise<void>;

export interface SpawnSubagentToolOptions {
  /** Parent run's session id — threaded into the derived subagent session id and the hook payloads. */
  parentSessionId: string;
  /** Parent run's chain depth (root = 0). Defaults to `0`. */
  currentDepth?: number;
  /** Max allowed chain depth (see {@link DEFAULT_MAX_SUBAGENT_DEPTH}). */
  maxDepth?: number;
  /** Builds and drives a subagent run; resolves with the summary returned as the tool result. */
  runSubagent: SubagentRunner;
  /** Optional hook emitter for the parent's `SubagentStart`/`SubagentEnd` lifecycle events. */
  onSubagentLifecycle?: SubagentLifecycleEmitter;
}

/**
 * Result payload returned by the `spawn_subagent` tool's `execute`. The
 * happy-path variant carries the subagent's session id + the captured
 * result summary so the calling model can read what its child agent
 * produced; the error variant is reserved for depth-cap rejections and
 * runner throws (the subagent never started or never completed cleanly).
 */
export interface SpawnSubagentToolResult {
  /** Subagent session id (`<parentSessionId>:sub:<uuid>`). Present on both success and error paths so the host can correlate hook payloads with the surfaced tool result. */
  subagentSessionId: string;
  /** Final status reported by the subagent's `stream_complete`. Omitted only on a depth-cap rejection (the subagent never ran). */
  status?: AgentCoreEventStatus;
  /** Concatenated assistant text from every `text_delta` the subagent yielded. Omitted on the depth-cap rejection path. */
  text?: string;
  usage?: TokenUsage | null;
  costUsd?: number;
  durationMs?: number;
  reason?: string;
  /** Populated on a depth-cap rejection or a runner throw; otherwise omitted. */
  error?: string;
}

/**
 * Factory for the built-in `spawn_subagent` tool (Phase 4.7). Lets the
 * parent model delegate a focused subtask to a child `OpenRouterAgentRun`
 * with its own session id and (optionally) a narrowed tool whitelist. The
 * parent waits for the subagent to complete and receives a single
 * {@link SpawnSubagentToolResult} as the tool_result — the subagent's own
 * event stream is captured inside `runSubagent` and does NOT bleed into
 * the parent's `for await`.
 *
 * The factory has no dependency on `OpenRouterAgentRun` — the agent wires
 * a `runSubagent` closure that captures the parent's `apiKey` / `baseUrl`
 * / `logsRoot` / `logger` / `onHook` / `model` / `appTitle` / `cwd` /
 * `persistSession` and constructs the child run at call time.
 *
 * Tool input shape (zod):
 * - `description: string` — the prompt handed to the subagent.
 * - `tools?: string[]` — optional whitelist of tool names. Unknown names
 *   are dropped silently (runner-side); omit to inherit the parent's
 *   full tool pool.
 * - `instructions?: string` — system instructions override; omit to
 *   inherit the parent's.
 * - `max_turns?: number` — per-subagent override; omit to inherit.
 * - `max_budget_usd?: number` — per-subagent override; omit to inherit.
 * - `model?: string` — per-subagent model override (Phase 4.8); omit to
 *   inherit the parent's resolved `model`.
 * - `permission_mode?: PermissionMode` — per-subagent permission preset
 *   (`'default'` / `'acceptEdits'` / `'bypassPermissions'` / `'plan'`)
 *   (Phase 4.8); omit to inherit the parent's `permissionMode`.
 * - `allowed_tools?: string[]` — per-subagent allow list using the
 *   Phase 3.2 rule grammar (Phase 4.8). REPLACES the parent's list —
 *   parent's `allowedTools` does NOT bleed into the child.
 * - `disallowed_tools?: string[]` — per-subagent deny list using the
 *   Phase 3.2 rule grammar (Phase 4.8). Also REPLACES rather than
 *   COMPOSES.
 * - `effort?: EffortLevel` — per-subagent reasoning-depth override
 *   (Phase 4.8 plumbed it through inheritance; Phase 5.4 wires it into the
 *   child's `callModel` request as `reasoning: { effort }`).
 *
 * Composition layers (innermost → outermost):
 * 1. `tools` (Phase 4.7) narrows the inherited tool *pool* by name.
 * 2. `permission_mode` (Phase 3.1) gates each call by tool name.
 * 3. `allowed_tools` / `disallowed_tools` (Phase 3.2) layer scoped rules
 *    on top of the mode gate.
 * 4. An optional caller-supplied `canUseTool` is the final word.
 *
 * The override semantics: each field, when supplied on the spawn call,
 * REPLACES the parent's resolved value on the child run's constructor.
 * Parent's mode/lists do NOT bleed in. (Composing would surprise users
 * — see the 4.8 PR body for the rationale.)
 *
 * The keys above are snake_case to match the model-facing tool-call
 * convention; they are mapped to camelCase on the child run's
 * constructor args.
 *
 * Recursion cap: the check `parent.depth + 1 >= maxDepth` fires before
 * the runner is invoked. On rejection the tool resolves with
 * `{ error: 'max subagent depth (<n>) exceeded', subagentSessionId }`
 * and a `SubagentEnd` (status `'error'`, reason matching) is still
 * emitted so audit consumers see a Start/End pair.
 *
 * Abort cascade: the subagent's abort signal is composed via
 * `AbortSignal.any([parentSignal, subagentInternalSignal])`, so the
 * parent's `abort()` (or any external signal threaded through `ctx.signal`)
 * propagates straight into the child without an explicit hand-off.
 */
/**
 * Zod schema for a single subagent spec — shared between the singular
 * `spawn_subagent` tool's input and each element of the plural
 * `spawn_subagents` (Phase 4.9) input array. Keeping them as one source
 * of truth means a per-subagent override added to one tool automatically
 * propagates to the other.
 */
export const SPAWN_SUBAGENT_INPUT_SCHEMA = z.object({
  description: z
    .string()
    .min(1)
    .describe('Prompt handed to the subagent — describe the subtask plainly.'),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "Optional whitelist of tool names the subagent may use (e.g. ['read_file', 'grep_files']). Unknown names are silently dropped. Omit to inherit the parent's full tool pool.",
    ),
  instructions: z
    .string()
    .optional()
    .describe("System instructions override. Omit to inherit the parent's."),
  max_turns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-subagent turn cap. Omit to inherit the parent's `maxTurns`."),
  max_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Per-subagent cost cap in USD. Omit to inherit the parent's `maxBudgetUsd`."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Per-subagent model override (e.g. `'~anthropic/claude-sonnet-latest'`). Omit to inherit the parent's resolved `model`.",
    ),
  permission_mode: z
    .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
    .optional()
    .describe("Per-subagent permission preset. Omit to inherit the parent's `permissionMode`."),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Per-subagent allow list using the same rule grammar as `OpenRouterAgentRun.allowedTools` (plain names or `Tool(pattern)`). REPLACES — does not compose with — the parent's allow list.",
    ),
  disallowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Per-subagent deny list using the same rule grammar as `OpenRouterAgentRun.disallowedTools`. REPLACES — does not compose with — the parent's deny list.",
    ),
  effort: z
    .enum(EFFORT_VALUES)
    .optional()
    .describe(
      "Per-subagent reasoning-depth override. OR maps the level to each provider's native param (OpenAI reasoning_effort, Anthropic thinking budget, Gemini thinkingLevel, Qwen thinking_budget, xAI reasoning_effort) and falls back to the nearest supported level when a model lacks the requested one. Omit to inherit the parent's `effort` (or leave unset if the parent also omitted it). Ignored by non-reasoning models.",
    ),
});

type SpawnSubagentInput = z.infer<typeof SPAWN_SUBAGENT_INPUT_SCHEMA>;

export function spawnSubagentTool(
  opts: SpawnSubagentToolOptions,
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  const parentDepth = opts.currentDepth ?? 0;
  return tool({
    name: 'spawn_subagent',
    description:
      "Delegate a focused subtask to a child agent with its own session and (optionally) a narrowed tool whitelist. The parent waits for the subagent to complete and receives the subagent's final assistant text plus status/cost as a single tool result. Use sparingly — only when the subtask has a clean, self-contained scope (research a question, refactor a file, run a verification pass). Returns `{ subagentSessionId, status, text, costUsd?, durationMs?, reason? }` on success or `{ error, subagentSessionId }` when the depth cap rejects or the runner throws.",
    inputSchema: SPAWN_SUBAGENT_INPUT_SCHEMA,
    execute: async (
      {
        description,
        tools,
        instructions,
        max_turns,
        max_budget_usd,
        model,
        permission_mode,
        allowed_tools,
        disallowed_tools,
        effort,
      },
      execCtx,
    ): Promise<SpawnSubagentToolResult> => {
      const subagentSessionId = `${opts.parentSessionId}:sub:${randomUUID()}`;
      const childDepth = parentDepth + 1;

      // Recursion cap — fire SubagentStart/End so audit consumers still see a
      // matched pair, then resolve with the depth-cap error. The runner is
      // never invoked on this path.
      if (childDepth >= maxDepth) {
        const reason = `max subagent depth (${maxDepth}) exceeded`;
        await opts.onSubagentLifecycle?.('SubagentStart', {
          event: 'SubagentStart',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          prompt: description,
          ...(tools !== undefined && { toolNames: tools }),
        });
        const errResult: SubagentResultSummary = { status: 'error', reason, text: '' };
        await opts.onSubagentLifecycle?.('SubagentEnd', {
          event: 'SubagentEnd',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          result: errResult,
        });
        return { error: reason, subagentSessionId };
      }

      // Compose the subagent's abort signal from the parent's (carried on
      // ctx.signal — usually the live SDK ToolExecuteContext doesn't expose
      // it, so we fall back to the factory-time ctx) and a subagent-internal
      // controller. The internal controller is unused here (no surface to
      // call abort() on it from outside), but it is documented for the
      // 4.9 parallel-subagent phase that will need finer-grained control.
      const subagentInternalCtl = new AbortController();
      const parentSignal = (execCtx as { signal?: AbortSignal } | undefined)?.signal ?? ctx.signal;
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, subagentInternalCtl.signal])
        : subagentInternalCtl.signal;

      await opts.onSubagentLifecycle?.('SubagentStart', {
        event: 'SubagentStart',
        parentSessionId: opts.parentSessionId,
        subagentSessionId,
        depth: childDepth,
        prompt: description,
        ...(tools !== undefined && { toolNames: tools }),
      });

      let result: SubagentRunResult;
      try {
        result = await opts.runSubagent({
          sessionId: subagentSessionId,
          prompt: description,
          ...(instructions !== undefined && { instructions }),
          ...(max_turns !== undefined && { maxTurns: max_turns }),
          ...(max_budget_usd !== undefined && { maxBudgetUsd: max_budget_usd }),
          ...(tools !== undefined && { toolNames: tools }),
          ...(model !== undefined && { model }),
          ...(permission_mode !== undefined && { permissionMode: permission_mode }),
          ...(allowed_tools !== undefined && { allowedTools: allowed_tools }),
          ...(disallowed_tools !== undefined && { disallowedTools: disallowed_tools }),
          ...(effort !== undefined && { effort }),
          signal,
          depth: childDepth,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errResult: SubagentResultSummary = { status: 'error', reason: message, text: '' };
        await opts.onSubagentLifecycle?.('SubagentEnd', {
          event: 'SubagentEnd',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          result: errResult,
        });
        return { error: message, subagentSessionId };
      }

      await opts.onSubagentLifecycle?.('SubagentEnd', {
        event: 'SubagentEnd',
        parentSessionId: opts.parentSessionId,
        subagentSessionId,
        depth: childDepth,
        result,
      });

      const out: SpawnSubagentToolResult = {
        subagentSessionId,
        status: result.status,
        text: result.text,
      };
      if (result.usage !== undefined) out.usage = result.usage;
      if (result.costUsd !== undefined) out.costUsd = result.costUsd;
      if (result.durationMs !== undefined) out.durationMs = result.durationMs;
      if (result.reason !== undefined) out.reason = result.reason;
      return out;
    },
  });
}

/**
 * Options accepted by {@link spawnSubagentsTool} (Phase 4.9). Shape-mirrors
 * {@link SpawnSubagentToolOptions} for the inheritance fields and adds a
 * concurrency cap. The same `runSubagent` closure the singular factory uses
 * is reused N times in a promise pool — no architectural divergence between
 * the two tools.
 */
export interface SpawnSubagentsToolOptions {
  /** Parent run's session id — threaded into the derived subagent session ids and hook payloads. */
  parentSessionId: string;
  /** Parent run's chain depth (root = 0). Defaults to `0`. */
  currentDepth?: number;
  /** Max allowed chain depth (see {@link DEFAULT_MAX_SUBAGENT_DEPTH}). */
  maxDepth?: number;
  /**
   * Maximum number of subagents allowed in-flight at once for a single
   * `spawn_subagents` call. Defaults to {@link DEFAULT_MAX_PARALLEL_SUBAGENTS}
   * (=4). The pool submits in array order; results return in array order
   * regardless of completion order.
   */
  maxParallel?: number;
  /** Builds and drives a single subagent run (reused N times in the pool). */
  runSubagent: SubagentRunner;
  /** Optional hook emitter for per-child `SubagentStart` / `SubagentEnd` lifecycle events. */
  onSubagentLifecycle?: SubagentLifecycleEmitter;
}

/**
 * Per-child envelope returned in the {@link SpawnSubagentsToolResult.results}
 * array. `status` is the parallel-tool classification — distinct from the
 * subagent's own terminal {@link AgentCoreEventStatus}:
 *
 * - `'success'` — runner resolved with a non-abort terminal status. `output`
 *   carries the {@link SubagentResultSummary}; `error` is omitted.
 * - `'error'` — depth-cap rejection OR runner throw OR the subagent's own
 *   `stream_complete` reported `status: 'error'` from a non-abort cause
 *   (constructor throw, stream throw, etc.). `error` carries the reason;
 *   `output` is the summary when one was produced, else `null`.
 * - `'aborted'` — the composite parent/internal abort signal fired and the
 *   subagent surfaced `reason: 'aborted'` (mapped to this status so the
 *   parent model can distinguish cancellation from other failures). `output`
 *   carries the abort summary; `error` carries `'aborted'`.
 */
export type SpawnSubagentResultEnvelope =
  | {
      status: 'success';
      subagentSessionId: string;
      output: SubagentResultSummary;
    }
  | {
      status: 'error';
      subagentSessionId: string;
      output: SubagentResultSummary | null;
      error: string;
    }
  | {
      status: 'aborted';
      subagentSessionId: string;
      output: SubagentResultSummary | null;
      error: string;
    };

/**
 * Aggregated payload returned by the `spawn_subagents` tool's execute.
 * `results` preserves submission order. `aggregatedUsage` sums cost +
 * tokens across `status: 'success'` entries ONLY; failed / aborted entries
 * are excluded (their cost is incomplete or undefined).
 */
export interface SpawnSubagentsToolResult {
  results: SpawnSubagentResultEnvelope[];
  aggregatedUsage: {
    usd: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
  };
  durationMs: number;
}

/**
 * Run promises through a fixed-size concurrency pool, preserving submission
 * order in the output array. No fail-fast — every spec is awaited, even
 * after one rejects. Used by {@link spawnSubagentsTool} so the model can
 * fan-out N subagents without saturating the OR API.
 *
 * Implementation: workers compete for the next index off a shared cursor.
 * Cheap, dependency-free, and ordering is preserved because each result is
 * written to `out[index]` (not pushed in completion order).
 */
async function runPool<T, R>(
  items: readonly T[],
  cap: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const concurrency = Math.max(1, Math.min(cap, items.length));
  let cursor = 0;
  const runOne = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(runOne());
  await Promise.all(workers);
  return out;
}

/**
 * Factory for the built-in `spawn_subagents` tool (Phase 4.9, plural).
 * Mirrors {@link spawnSubagentTool} but accepts an array of subagent specs
 * and runs them through a concurrency-capped promise pool. No fail-fast —
 * a per-child failure isolates to that child's envelope, and the
 * aggregate summary sums cost / tokens across SUCCESSFUL children only.
 *
 * Tool input shape (zod):
 * - `subagents: Array<...>` — 1 to {@link MAX_PARALLEL_BATCH_SIZE} entries,
 *   each matching {@link SPAWN_SUBAGENT_INPUT_SCHEMA} (the same per-spec
 *   shape `spawn_subagent` accepts — `description` required, every other
 *   field optional). Each spec is run as its own subagent; per-spec
 *   overrides (`model` / `permission_mode` / `allowed_tools` /
 *   `disallowed_tools` / `effort` from Phase 4.8) propagate independently.
 *
 * Concurrency: capped by the factory's `maxParallel` (default
 * {@link DEFAULT_MAX_PARALLEL_SUBAGENTS} = 4). The pool submits in array
 * order; results return in array order regardless of completion order.
 *
 * Per-child failure isolation: when one subagent throws, aborts, or hits
 * a non-success terminal status, the others continue. Each envelope is
 * `{ status: 'success' | 'error' | 'aborted', subagentSessionId, output,
 * error? }`. Aggregated `costUsd` + token totals sum the `'success'`
 * envelopes only.
 *
 * Parent abort cascade: identical to {@link spawnSubagentTool} — each
 * child's signal is composed via `AbortSignal.any([parentSignal,
 * subagentInternalCtl.signal])`, so a parent abort fans out into every
 * in-flight child.
 *
 * Recursion-depth cap: same gate as the singular tool. A depth-N parent
 * whose `childDepth >= maxDepth` rejects EACH spec with a per-child
 * envelope (`status: 'error'`, `error: 'max subagent depth (N) exceeded'`)
 * and STILL fires a matched `SubagentStart` / `SubagentEnd` pair per child
 * so audit consumers see the rejection.
 *
 * Lifecycle hooks: `SubagentStart` / `SubagentEnd` fire once per child
 * (no new event types for the plural case). Pairs may interleave when
 * children run in parallel — consumers must correlate on
 * `subagentSessionId`.
 *
 * Budget propagation: each child inherits the parent's `maxBudgetUsd`
 * independently by default. Per-spec override via `max_budget_usd`.
 * Aggregate cost may therefore exceed any single child's cap.
 */
export function spawnSubagentsTool(
  opts: SpawnSubagentsToolOptions,
  ctx: ToolContext = DEFAULT_TOOL_CONTEXT,
) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  const parentDepth = opts.currentDepth ?? 0;
  const maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL_SUBAGENTS;
  return tool({
    name: 'spawn_subagents',
    description:
      'Delegate MULTIPLE focused subtasks to child agents in parallel. Each spec runs as its own subagent (same per-element schema as `spawn_subagent`). Results are returned in submission order regardless of completion order. Per-child failures isolate (the others keep running). Aggregate cost and token totals sum across successful children only. Use when several subtasks are independent and can run concurrently — for sequential delegation, prefer `spawn_subagent`. Returns `{ results, aggregatedUsage, durationMs }`.',
    inputSchema: z.object({
      subagents: z
        .array(SPAWN_SUBAGENT_INPUT_SCHEMA)
        .min(1)
        .max(MAX_PARALLEL_BATCH_SIZE)
        .describe(
          `Array of subagent specs (1 to ${MAX_PARALLEL_BATCH_SIZE}). Each element accepts the same fields as the singular spawn_subagent tool — required \`description\` plus optional per-spec overrides (\`tools\` / \`instructions\` / \`max_turns\` / \`max_budget_usd\` / \`model\` / \`permission_mode\` / \`allowed_tools\` / \`disallowed_tools\` / \`effort\`). Concurrency is capped at the factory's \`maxParallel\` (default ${DEFAULT_MAX_PARALLEL_SUBAGENTS}); larger arrays queue.`,
        ),
    }),
    execute: async ({ subagents }, execCtx): Promise<SpawnSubagentsToolResult> => {
      const startMs = Date.now();
      const parentSignal = (execCtx as { signal?: AbortSignal } | undefined)?.signal ?? ctx.signal;

      const runOne = async (spec: SpawnSubagentInput): Promise<SpawnSubagentResultEnvelope> => {
        const subagentSessionId = `${opts.parentSessionId}:sub:${randomUUID()}`;
        const childDepth = parentDepth + 1;

        // Depth-cap rejection — surface a matched Start/End pair (audit
        // parity with singular tool) and an `error` envelope. Runner is
        // never invoked on this path.
        if (childDepth >= maxDepth) {
          const reason = `max subagent depth (${maxDepth}) exceeded`;
          await opts.onSubagentLifecycle?.('SubagentStart', {
            event: 'SubagentStart',
            parentSessionId: opts.parentSessionId,
            subagentSessionId,
            depth: childDepth,
            prompt: spec.description,
            ...(spec.tools !== undefined && { toolNames: spec.tools }),
          });
          const errResult: SubagentResultSummary = { status: 'error', reason, text: '' };
          await opts.onSubagentLifecycle?.('SubagentEnd', {
            event: 'SubagentEnd',
            parentSessionId: opts.parentSessionId,
            subagentSessionId,
            depth: childDepth,
            result: errResult,
          });
          return {
            status: 'error',
            subagentSessionId,
            output: null,
            error: reason,
          };
        }

        const subagentInternalCtl = new AbortController();
        const signal = parentSignal
          ? AbortSignal.any([parentSignal, subagentInternalCtl.signal])
          : subagentInternalCtl.signal;

        await opts.onSubagentLifecycle?.('SubagentStart', {
          event: 'SubagentStart',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          prompt: spec.description,
          ...(spec.tools !== undefined && { toolNames: spec.tools }),
        });

        let summary: SubagentRunResult;
        try {
          summary = await opts.runSubagent({
            sessionId: subagentSessionId,
            prompt: spec.description,
            ...(spec.instructions !== undefined && { instructions: spec.instructions }),
            ...(spec.max_turns !== undefined && { maxTurns: spec.max_turns }),
            ...(spec.max_budget_usd !== undefined && { maxBudgetUsd: spec.max_budget_usd }),
            ...(spec.tools !== undefined && { toolNames: spec.tools }),
            ...(spec.model !== undefined && { model: spec.model }),
            ...(spec.permission_mode !== undefined && { permissionMode: spec.permission_mode }),
            ...(spec.allowed_tools !== undefined && { allowedTools: spec.allowed_tools }),
            ...(spec.disallowed_tools !== undefined && {
              disallowedTools: spec.disallowed_tools,
            }),
            ...(spec.effort !== undefined && { effort: spec.effort }),
            signal,
            depth: childDepth,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errResult: SubagentResultSummary = {
            status: 'error',
            reason: message,
            text: '',
          };
          await opts.onSubagentLifecycle?.('SubagentEnd', {
            event: 'SubagentEnd',
            parentSessionId: opts.parentSessionId,
            subagentSessionId,
            depth: childDepth,
            result: errResult,
          });
          return {
            status: 'error',
            subagentSessionId,
            output: null,
            error: message,
          };
        }

        await opts.onSubagentLifecycle?.('SubagentEnd', {
          event: 'SubagentEnd',
          parentSessionId: opts.parentSessionId,
          subagentSessionId,
          depth: childDepth,
          result: summary,
        });

        // Classification: a child run that observed the composite abort
        // signal surfaces `status: 'error'` with `reason: 'aborted'` from
        // its terminal stream_complete. Map that to the envelope's
        // `'aborted'` so the parent model sees cancellation distinct from
        // other failures.
        if (summary.status === 'error' && summary.reason === 'aborted') {
          return {
            status: 'aborted',
            subagentSessionId,
            output: summary,
            error: 'aborted',
          };
        }
        if (summary.status === 'error') {
          return {
            status: 'error',
            subagentSessionId,
            output: summary,
            error: summary.reason ?? 'subagent errored',
          };
        }
        return {
          status: 'success',
          subagentSessionId,
          output: summary,
        };
      };

      const results = await runPool(subagents, maxParallel, runOne);

      // Sum cost + token usage across success envelopes only — partial /
      // failed children carry incomplete or undefined usage and must not
      // contaminate the aggregate.
      let usd = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let totalTokens = 0;
      for (const r of results) {
        if (r.status !== 'success') continue;
        if (r.output.costUsd !== undefined) usd += r.output.costUsd;
        const u = r.output.usage;
        if (u) {
          tokensIn += u.inputTokens;
          tokensOut += u.outputTokens;
          totalTokens += u.totalTokens;
        }
      }

      return {
        results,
        aggregatedUsage: { usd, tokensIn, tokensOut, totalTokens },
        durationMs: Date.now() - startMs,
      };
    },
  });
}
