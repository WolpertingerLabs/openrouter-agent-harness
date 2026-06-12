// Dual-mode comparative-parity harness (Phase 6.3).
//
// Runs a scenario through BOTH `@anthropic-ai/claude-agent-sdk` and
// `@openrouter/agent`'s `OpenRouterAgentRun` against a single in-process
// emulator, captures append-only transcripts from each, and returns them for
// the 6.4 comparator to consume. Independent emulator instances per SDK so
// neither side's turn-cursor pollutes the other (proves no shared global
// state — `Promise.all`-driven concurrent execution surfaces any mistake here
// immediately).
//
// === Asymmetric base-URL plumbing (LOAD-BEARING — DO NOT UNIFY) ===
//
// OR side       → `baseUrl: emulator.url` ctor option on `OpenRouterAgentRun`
//                 → flows through to the OR client constructor's `serverURL`
//                 (`src/agent.ts:934`). In-process, ctor-arg.
// Anthropic side → per-`query()` `Options.env: { ANTHROPIC_BASE_URL: ... }`
//                 injection. Per 6.S1 spike, the agent SDK spawns a fresh
//                 `claude` subprocess per call and reads `ANTHROPIC_BASE_URL`
//                 *inside* that subprocess — NOT at parent import time. So
//                 env-isolation is structural; a parent `process.env` mutation
//                 would be both unnecessary and dangerous (would poison sibling
//                 tests). DO NOT replace this with `process.env.ANTHROPIC_BASE_URL = ...`.
//
// The shapes differ because the wire formats differ (`/v1/messages` vs.
// `/v1/chat/completions` vs. `/responses`). A shared "set the base URL" helper
// would have to fork on which SDK it's configuring — at which point you're
// back to two distinct call sites with extra plumbing on top. Two lines stays
// two lines.
//
// === TODO breadcrumbs ===
//
// TODO(6.4): the comparator. This file ONLY returns transcripts. The
//   `expect(orTranscript).toEqual(anthropicTranscript)` assertion lives in
//   6.4's `comparator.ts`. Resist adding it here.
// TODO(6.5): scenario expansion (#1–#12). v1 only consumes the minimal Zod
//   schema; failure-injection / tolerance bands are 6.5/6.6.
// TODO(6.3-followup): `/responses` adapter for full OR-side end-to-end. The
//   OR SDK's `callModel` routes through `/responses` (beta), which neither
//   6.1's `/v1/messages` adapter nor 6.2's `/v1/chat/completions` adapter
//   serves. Until that lands, the OR-side smoke transcript will surface an
//   error event for the 404 — the harness PLUMBING is exercised, but the
//   round-trip is not. See PR-body ambiguity call #7.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { query, type CanUseTool as AnthropicCanUseTool } from '@anthropic-ai/claude-agent-sdk';

import { OpenRouterAgentRun, type CanUseTool as OrCanUseTool } from '../../agent.js';

import { startEmulator, type EmulatorHandle, type ScriptEntry } from './emulator/index.js';
import { entriesForWire, loadScenario, type Scenario } from './scenarios.js';
import { anthropicToolName, buildHarnessTools } from './scenarios/_tools.js';
import {
  maskNondeterminism,
  type AnthropicTranscript,
  type OrTranscript,
  type ScenarioTranscripts,
} from './transcript.js';

export type HarnessMode = 'emulated' | 'live';

export type RunScenarioOptions = {
  /**
   * Per-run timeout for each SDK. Defaults to 30s (or the scenario's
   * `harnessTimeoutMs` field if set). Generous enough to absorb the agent
   * SDK's subprocess cold-start (~1-2s on Linux per 6.S1) plus a few SSE
   * turns; tight enough to surface real hangs as test failures rather than
   * CI timeouts. An explicit value here overrides BOTH the default and the
   * scenario field.
   */
  timeoutMs?: number;
  /**
   * Override the failure-dump root. Defaults to `<cwd>/tmp/comparative-failures`.
   * Tests can point this at a temp dir to avoid cluttering the project's
   * `tmp/` during the env-leakage and self-test runs.
   */
  failureDumpRoot?: string;
  /**
   * Phase 6.7 live-mode cost cap. Sum of costUsd across BOTH SDKs is
   * monitored during the run; if the sum exceeds this number, the harness
   * aborts BOTH AbortControllers and records the breach on the returned
   * `costReport`. An explicit value here overrides BOTH the default and the
   * scenario's `maxCostUsd` field. Defaults: scenario.maxCostUsd ?? 0.50.
   * In emulated mode the SDKs always report costUsd=0 so this knob is a
   * no-op there.
   */
  maxCostUsd?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COST_USD = 0.5;

/**
 * Run a scenario through both SDKs concurrently and capture their transcripts.
 *
 * `mode: 'emulated'` — spins up one emulator per SDK on its own ephemeral
 * port, points each SDK at its emulator via the appropriate base-URL override
 * (see file header), seeds the scenario's script entries into each
 * emulator's registry filtered by `wire`. The two emulator instances exist
 * for isolation: a multi-turn scenario that races concurrent requests cannot
 * cross-pollute turn cursors.
 *
 * `mode: 'live'` — Phase 6.7. Skips emulator setup entirely; both SDKs hit
 * real provider endpoints using `OPENROUTER_API_KEY` + `ANTHROPIC_API_KEY`
 * from the calling environment. The harness tracks the SUM of `costUsd` across
 * both SDKs against the resolved budget cap (scenario `maxCostUsd` field or
 * `DEFAULT_MAX_COST_USD`); on breach, BOTH abortControllers fire and
 * `costBreach: true` is set on the return — captured-so-far transcripts are
 * returned for inspection. Skipping the run when API keys are absent is the
 * caller's responsibility (see the live-smoke driver) — the harness does NOT
 * silently fall back to emulated; a missing key surfaces as the SDK's own
 * authentication error.
 *
 * Failure handling: if either SDK throws (vs. emitting an `error` event), the
 * transcripts captured so far are dumped to disk under
 * `<failureDumpRoot>/<scenarioName>-<isoTimestamp>/` and the throw is
 * recorded on the transcript's `thrown` field. The function then resolves
 * normally so the caller (a vitest `it` block) can decide whether to fail
 * the test based on transcript content. We choose fail-fast at the SDK level
 * (we don't try to "best-effort capture more after a throw") because the
 * harness exists to prevent silent rot — a throw mid-capture means we've
 * already lost ordering information, and pretending otherwise hides bugs.
 */
export async function runScenario(
  scenarioPath: string,
  mode: HarnessMode,
  options: RunScenarioOptions = {},
): Promise<ScenarioTranscripts> {
  const scenario = await loadScenario(scenarioPath);
  const failureDumpRoot =
    options.failureDumpRoot ?? join(process.cwd(), 'tmp', 'comparative-failures');
  const timeoutMs = options.timeoutMs ?? scenario.harnessTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCostUsd = options.maxCostUsd ?? scenario.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const budget = createBudgetMonitor(maxCostUsd);

  let anthropicEmulator: EmulatorHandle | undefined;
  let orEmulator: EmulatorHandle | undefined;
  let anthropicBaseUrl: string | undefined;
  let orBaseUrl: string | undefined;

  if (mode === 'emulated') {
    // One emulator per SDK so script cursors don't cross-pollinate. Each
    // emulator binds to its own ephemeral port (`server.listen(0)`).
    anthropicEmulator = await startEmulator();
    orEmulator = await startEmulator();
    anthropicBaseUrl = anthropicEmulator.url;
    orBaseUrl = orEmulator.url;

    // Seed each registry with only the entries that target its wire format.
    // Entries that don't match are silently skipped (the wire-mismatch path is
    // owned by the script-engine when a request actually arrives).
    registerEntries(anthropicEmulator, entriesForWire(scenario, 'anthropic'));
    // The OR SDK posts to `/responses` (OpenResponses wire) in production. The
    // 6.2 `/v1/chat/completions` adapter is still registered into the OR
    // emulator so scenarios that historically scripted `openai` entries don't
    // break, but `openresponses` is the wire the SDK actually hits.
    registerEntries(orEmulator, entriesForWire(scenario, 'openresponses'));
    registerEntries(orEmulator, entriesForWire(scenario, 'openai'));
  }

  let transcripts: [AnthropicTranscript, OrTranscript];
  try {
    // Promise.all so both SDKs run truly concurrently. Each side captures
    // its own transcript; a throw on one side does NOT abort the other (we
    // wrap each in its own catch so we can dump partial transcripts from
    // BOTH on a single side's failure).
    const anthropicPromise = captureAnthropic(scenario, anthropicBaseUrl, timeoutMs, budget).catch(
      (err) => failedAnthropicTranscript(err),
    );
    const orPromise = captureOpenRouter(scenario, orBaseUrl, timeoutMs, budget).catch((err) =>
      failedOrTranscript(err),
    );

    transcripts = await Promise.all([anthropicPromise, orPromise]);
  } finally {
    if (anthropicEmulator) await anthropicEmulator.stop();
    if (orEmulator) await orEmulator.stop();
  }
  const [anthropicTranscript, orTranscript] = transcripts;

  if (anthropicTranscript.thrown || orTranscript.thrown) {
    await dumpFailure(failureDumpRoot, scenario, { anthropicTranscript, orTranscript });
  }

  return {
    anthropicTranscript,
    orTranscript,
    ...(budget.breached && { costBreach: true }),
  };
}

function registerEntries(emulator: EmulatorHandle, entries: ScriptEntry[]): void {
  for (const entry of entries) emulator.registry.register(entry);
}

// ----- Budget monitor (Phase 6.7) -----
//
// Tracks the cumulative `costUsd` reported across BOTH SDKs and exposes a
// shared breach signal so a single abort path collapses both runs. Used by
// live mode; in emulated mode the SDKs never report cost so the monitor is
// a no-op (`add(0)` calls are harmless and the cap is never breached).

type BudgetMonitor = {
  readonly maxCostUsd: number;
  total: number;
  breached: boolean;
  /** Capture-side abort callbacks; both SDKs register their controllers. */
  readonly abortCallbacks: Array<() => void>;
  /** Accumulate a cost delta; fire abort callbacks once on first breach. */
  add: (delta: number) => void;
  /** Register an abort callback. Called immediately if breach already happened. */
  registerAbort: (cb: () => void) => void;
};

function createBudgetMonitor(maxCostUsd: number): BudgetMonitor {
  const monitor: BudgetMonitor = {
    maxCostUsd,
    total: 0,
    breached: false,
    abortCallbacks: [],
    add(delta) {
      if (!Number.isFinite(delta) || delta <= 0) return;
      this.total += delta;
      if (!this.breached && this.total > this.maxCostUsd) {
        this.breached = true;
        for (const cb of this.abortCallbacks) cb();
      }
    },
    registerAbort(cb) {
      this.abortCallbacks.push(cb);
      if (this.breached) cb();
    },
  };
  return monitor;
}

/**
 * Sum `total_cost_usd` across Anthropic `result` SDKMessages. The masked
 * transcript preserves cost fields verbatim (only timing/UUIDs are scrubbed).
 */
function extractAnthropicCost(message: Record<string, unknown>): number {
  if (message.type !== 'result') return 0;
  const cost = message.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}

/**
 * Pull the latest `costUsd` from a captured OR `AgentCoreEvent`. The OR SDK
 * reports cumulative cost on `turn_end`, `stream_complete`, and `session_end`
 * — we use the DELTA from one observation to the next so the budget monitor
 * sees an incremental update each event. The caller passes the previously
 * observed running total; this returns the new total (NOT the delta), and
 * the caller computes `new - prev` to feed the monitor.
 */
function extractOrCost(event: { type: string; costUsd?: number }): number | undefined {
  if (typeof event.costUsd !== 'number' || !Number.isFinite(event.costUsd)) return undefined;
  return event.costUsd;
}

/**
 * Build the env we hand to the spawned `claude` CLI subprocess. We DO spread
 * `process.env` (PATH/HOME/TMPDIR have to flow through for the subprocess to
 * find its binary, write temp files, etc.) but we EXPLICITLY scrub any env
 * vars that signal "you're being invoked from another Claude Code instance".
 *
 * Why: when this test suite is run from inside a Claude Code session
 * (whether interactively or in a CI runner with `CLAUDECODE=1` set), the
 * parent process exports a bundle of `CLAUDE_*` / `CLAUDECODE` /
 * `CLAUDE_CODE_*` env vars. The spawned `claude` subprocess detects them,
 * decides it's nested in another Claude Code instance, and inherits the
 * parent's tool-palette context — adding ~29 ambient tools (`Agent`,
 * `AskUserQuestion`, `Bash`, `CronCreate`, etc.) into the API request body
 * that hash-canonicalization sees. The recorded scenario hashes were taken
 * on a clean machine WITHOUT these env vars, so the hashes diverge in the
 * "nested" case and every scenario script-misses.
 *
 * The fix is a deny-list of known parent-Claude-Code env vars rather than
 * an allow-list: the CLI legitimately depends on a wide range of system env
 * vars (PATH, HOME, TMPDIR, LANG, LC_*, NODE_*, etc.) and an allow-list
 * would either miss something or grow stale. The deny-list is narrow and
 * its membership criterion is concrete: any var whose name encodes "we are
 * Claude Code". `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are explicit
 * arguments to this function (callers set them per-mode) so they are NOT
 * filtered here — the override-spread at the call site handles them.
 *
 * GitHub Actions sets `GITHUB_ACTIONS=true` and `CI=true`. The CI runner
 * ALSO sets `CLAUDECODE=1` if Claude Code is invoking the workflow (via
 * the same SDK we're calling). Those env vars get scrubbed too.
 */
const PARENT_CLAUDE_ENV_DENY_PREFIXES = ['CLAUDE_', 'CLAUDECODE'] as const;

/**
 * Env vars whose mere presence signals "you are running in a CI/build
 * environment" to the bundled `claude` binary. Empirically (via
 * `strings node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`),
 * the binary checks for these names from the ci-info package — when ANY of
 * them is set, the binary takes a different code path that injects more
 * system-reminder content (a richer skills list + current-date block) into
 * the API request body. That makes the request body — and therefore its
 * canonical hash — diverge from the recorded fixtures.
 *
 * We scrub these from the subprocess env (NOT from `process.env`, which
 * would poison sibling tests per the file header). The deny-list comes
 * straight from the ci-info package's well-known marker list.
 *
 * `GITHUB_REPOSITORY` and similar PR-context vars are NOT scrubbed because
 * they don't trigger the alternate code path on their own; only the boolean
 * "I am a CI build" markers do.
 */
const CI_MARKER_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'APPVEYOR',
  'BUILDKITE',
  'CIRCLECI',
  'DRONE',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'TRAVIS',
  'CI_NAME',
] as const;

function sanitizeParentEnvForClaudeSubprocess(
  source: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const ciMarkers = new Set<string>(CI_MARKER_ENV_VARS);
  for (const [k, v] of Object.entries(source)) {
    if (PARENT_CLAUDE_ENV_DENY_PREFIXES.some((prefix) => k.startsWith(prefix))) continue;
    if (ciMarkers.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ----- Anthropic side capture -----

/**
 * Drives the Claude Agent SDK via `query()` with `Options.env` carrying our
 * emulator URL + a stub API key. We deliberately pass `{ ...process.env, ... }`
 * so PATH / HOME / TMPDIR still reach the spawned `claude` subprocess (per
 * 6.S1's hosting-pattern note); the override fields go LAST so they win any
 * collision with the parent env. The parent process's `ANTHROPIC_BASE_URL`
 * (if any) is preserved into the spread but immediately overridden — so this
 * call site CANNOT leak the emulator URL into the parent.
 */
async function captureAnthropic(
  scenario: Scenario,
  emulatorUrl: string | undefined,
  timeoutMs: number,
  budget: BudgetMonitor,
): Promise<AnthropicTranscript> {
  const messages: Array<Record<string, unknown>> = [];
  const abortController = new AbortController();
  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    abortController.abort();
  }, timeoutMs);
  timer.unref();
  budget.registerAbort(() => abortController.abort());
  let observedCost = 0;

  // Per-scenario tool wiring. Built INSIDE this function (not shared with
  // the OR side) so the `counter` fixture's closure state is independent
  // between the two SDKs — otherwise scenario #3's counter would emit `1,2`
  // on the SDK that ran first and `3,4` on the slower one, breaking parity.
  const tools = buildHarnessTools(scenario.tools ?? []);
  const canUseTool = buildAnthropicCanUseTool(scenario);
  const deniedToolNames = new Set(
    (scenario.canUseToolPolicy ?? [])
      .filter((rule) => rule.action === 'deny')
      .map((rule) => anthropicToolName(rule.tool)),
  );
  const allowedToolNamesAfterPolicy = tools.anthropicAllowedToolNames.filter(
    (name) => !deniedToolNames.has(name),
  );

  // Phase 6.7: in live mode (`emulatorUrl` undefined) we DON'T override
  // ANTHROPIC_BASE_URL — the SDK hits Anthropic's production endpoint. The
  // API key comes from the calling environment (`ANTHROPIC_API_KEY`). The
  // spread of `process.env` preserves it; if absent, the SDK surfaces an
  // authentication error which the test driver propagates.
  const envOverrides: Record<string, string> =
    emulatorUrl !== undefined
      ? {
          ANTHROPIC_BASE_URL: emulatorUrl,
          ANTHROPIC_API_KEY: 'sk-ant-emulator-stub',
        }
      : {};

  try {
    const q = query({
      prompt: scenario.prompt,
      options: {
        env: {
          ...sanitizeParentEnvForClaudeSubprocess(process.env),
          ...envOverrides,
        },
        abortController,
        // `settingSources: []` puts the SDK in isolation mode — no
        // `.claude/settings.json` hierarchies, no project-level settings —
        // so the request body the SDK sends doesn't pick up per-machine
        // configuration. (System-reminder blocks from `~/.claude/CLAUDE.md`
        // and skills are still inserted by the CLI and stripped at hash
        // time; this is the other half of the per-machine isolation.)
        settingSources: [],
        ...(scenario.model && { model: scenario.model }),
        ...(scenario.systemPrompt && { systemPrompt: scenario.systemPrompt }),
        // Phase 6.9 backfill #154: thread the scenario's `effort` knob into
        // the Claude Agent SDK. The SDK's request-body mapping (`thinking`)
        // is invisible to the Anthropic canonical hash, but the option is
        // still accepted at the SDK boundary and reaches the subprocess.
        ...(scenario.effort !== undefined && { effort: scenario.effort }),
        // Scenario #23: `cacheControl` is intentionally NOT forwarded on
        // the Anthropic side. The Claude Agent SDK's `query()` `Options`
        // exposes no top-level cacheControl directive — prompt caching on
        // Anthropic is per-content-block via `cache_control` on
        // `TextBlockParam`, a different mechanism. The scenario field is
        // OR-only by design; the Anthropic hash matches the no-cache case.
        // Phase 6.5b: enable per-chunk message events when a cancellation
        // policy is set. The Anthropic SDK normally buffers the streaming
        // response and emits ONE coalesced `assistant` message; without
        // partial events the harness can only observe the request after it
        // completes, so an `afterEventsAnthropic` abort fires post-stream
        // instead of mid-stream and the scenario can't exercise its target
        // behavior. `includePartialMessages: true` opts into per-chunk
        // `stream_event`/`partial_assistant` messages so the abort lands at
        // the intended chunk boundary. The wire request body is unaffected
        // — partial-messages is a client-side toggle — so canonical hashes
        // stay stable.
        ...(scenario.cancellation && { includePartialMessages: true }),
        ...(tools.anthropicMcpServer && {
          mcpServers: { [tools.anthropicMcpServer.name]: tools.anthropicMcpServer },
        }),
        // Policy-DENIED tools must NOT be allow-listed. An `allowedTools`
        // entry auto-allows at the CLI's permission layer, so `canUseTool`
        // is never consulted for it and a `deny` rule silently can't engage
        // — the tool executes and the "denial" scenarios exercise nothing.
        // (Latent since the 6.5a recordings; exposed when the OR side's
        // tool-error signaling started marking denials `isError: true` and
        // the comparator caught the asymmetry.) Dropping the denied names
        // routes those calls through `canUseTool` → `behavior: 'deny'`,
        // which the CLI surfaces as an is_error tool_result — matching the
        // OR side's denial semantics.
        ...(allowedToolNamesAfterPolicy.length > 0 && {
          allowedTools: allowedToolNamesAfterPolicy,
        }),
        ...(canUseTool && { canUseTool }),
      },
    });
    const cancelAfter = scenario.cancellation?.afterEventsAnthropic;
    for await (const msg of q) {
      const cloned = maskNondeterminism(msg as unknown as Record<string, unknown>);
      messages.push(cloned);
      // Phase 6.7: accumulate observed cost (only `result` SDKMessages carry
      // `total_cost_usd`; everything else returns 0 here). On budget breach
      // the BudgetMonitor will fire abort on our controller via the
      // `registerAbort` callback above — we don't need to do anything else.
      const cost = extractAnthropicCost(cloned);
      if (cost > observedCost) {
        budget.add(cost - observedCost);
        observedCost = cost;
      }
      // Phase 6.5b: mid-stream cancellation. We trigger the abort from the
      // capture loop AFTER the Nth message has been pushed — so the
      // transcript captures the trigger-point event, the SDK observes the
      // signal on its next read, and the iterator surfaces an AbortError.
      // Per-SDK threshold (not shared) so each side cancels at its own
      // observable boundary; see the cancellation block on `scenarioSchema`
      // for why event granularity differs between SDKs.
      if (cancelAfter !== undefined && messages.length >= cancelAfter) {
        abortController.abort();
      }
    }
  } catch (err) {
    if (timeoutHit) {
      return {
        wire: 'anthropic',
        messages,
        thrown: `Anthropic-side capture timed out after ${timeoutMs}ms`,
        costUsd: observedCost,
      };
    }
    return {
      wire: 'anthropic',
      messages,
      thrown: formatThrown(err),
      costUsd: observedCost,
    };
  } finally {
    clearTimeout(timer);
  }
  return { wire: 'anthropic', messages, costUsd: observedCost };
}

function failedAnthropicTranscript(err: unknown): AnthropicTranscript {
  return { wire: 'anthropic', messages: [], thrown: formatThrown(err), costUsd: 0 };
}

// ----- OpenRouter side capture -----

/**
 * Drives `OpenRouterAgentRun` with `baseUrl` set to the emulator. We use
 * `persistSession: false` so the run does NOT write to `logs/` during the
 * test (no on-disk pollution, no test-runner working-dir surprises). The
 * `apiKey` is a stub — the emulator ignores it. Tools are explicitly empty:
 * the scaffolding doesn't need tool plumbing to exercise base-URL routing.
 *
 * Subscribes to the run's `AgentCoreEvent` async-iterable and captures every
 * event in fire order. Hooks (`Setup` / `SessionStart` / `SessionEnd` /
 * `Stop`) are deliberately NOT captured here — their fire-order parity is
 * captured by the AgentCoreEvent stream's structural events
 * (`session_started` / `stream_complete`); the hook surface is a separate
 * audit concern that 6.4 may decide to fold in.
 */
async function captureOpenRouter(
  scenario: Scenario,
  emulatorUrl: string | undefined,
  timeoutMs: number,
  budget: BudgetMonitor,
): Promise<OrTranscript> {
  const events: AgentEventCapture[] = [];
  const abortController = new AbortController();
  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    abortController.abort();
  }, timeoutMs);
  timer.unref();
  budget.registerAbort(() => abortController.abort());
  let observedCost = 0;

  // Per-scenario tool wiring (independent state — see captureAnthropic).
  const tools = buildHarnessTools(scenario.tools ?? []);
  const canUseTool = buildOrCanUseTool(scenario);

  // Phase 6.7: in live mode (`emulatorUrl` undefined) read the real
  // `OPENROUTER_API_KEY` from the environment. In emulated mode the stub
  // key is sufficient — the emulator ignores Authorization.
  const apiKey =
    emulatorUrl !== undefined
      ? 'sk-or-emulator-stub'
      : (process.env.OPENROUTER_API_KEY ?? 'sk-or-emulator-stub');

  let run: OpenRouterAgentRun | undefined;
  try {
    run = new OpenRouterAgentRun({
      apiKey,
      sessionId: `comparative-${scenario.name}`,
      prompt: scenario.prompt,
      ...(emulatorUrl !== undefined && { baseUrl: emulatorUrl }),
      persistSession: false,
      signal: abortController.signal,
      tools: tools.orTools,
      ...(scenario.model && { model: scenario.model }),
      ...(scenario.systemPrompt && { instructions: scenario.systemPrompt }),
      // Phase 6.9 backfill #154: per-run effort knob → production agent.ts
      // forwards it as `reasoning: { effort }` on the `callModel` request
      // body. The OR canonical projection (`script-engine.ts`'s `reasoning`
      // field) surfaces it, so the request hash differs from scenario #01.
      ...(scenario.effort !== undefined && { effort: scenario.effort }),
      // Scenario #23: per-run OR auto-prompt-cache directive →
      // production agent.ts forwards it as the top-level `cacheControl`
      // field on the `callModel` request body. The OR canonical projection
      // does NOT include `cache_control`, so the request hash matches the
      // no-cache case for the same prompt/model combo — the parity claim
      // is event-stream equality with the option set, not hash difference.
      ...(scenario.cacheControl !== undefined && { cacheControl: scenario.cacheControl }),
      ...(canUseTool && { canUseTool }),
    });
    const cancelAfter = scenario.cancellation?.afterEventsOr;
    for await (const event of run) {
      const masked = maskNondeterminism(event);
      events.push(masked);
      // Phase 6.7: track cumulative cost from any event that carries it.
      // The OR SDK reports a monotonically-growing `costUsd` on `turn_end`,
      // `stream_complete`, and `session_end`. We feed the budget monitor
      // the DELTA so back-to-back observations don't double-count.
      const cost = extractOrCost(masked as { type: string; costUsd?: number });
      if (cost !== undefined && cost > observedCost) {
        budget.add(cost - observedCost);
        observedCost = cost;
      }
      // Phase 6.5b: same per-SDK abort-after-N-events pattern as the
      // Anthropic side (see captureAnthropic). Each side cancels at its own
      // observable boundary; thresholds in the JSON are independent because
      // OR emits per-chunk `text_delta` events while Anthropic batches text
      // into one `assistant` message.
      if (cancelAfter !== undefined && events.length >= cancelAfter) {
        abortController.abort();
      }
    }
  } catch (err) {
    if (timeoutHit) {
      return {
        wire: 'openrouter',
        events,
        thrown: `OpenRouter-side capture timed out after ${timeoutMs}ms`,
        costUsd: observedCost,
      };
    }
    return {
      wire: 'openrouter',
      events,
      thrown: formatThrown(err),
      costUsd: observedCost,
    };
  } finally {
    clearTimeout(timer);
  }
  return { wire: 'openrouter', events, costUsd: observedCost };
}

function failedOrTranscript(err: unknown): OrTranscript {
  return { wire: 'openrouter', events: [], thrown: formatThrown(err), costUsd: 0 };
}

type AgentEventCapture = Parameters<
  typeof maskNondeterminism<import('../../events.js').AgentCoreEvent>
>[0];

// ----- Failure dump -----

async function dumpFailure(
  root: string,
  scenario: Scenario,
  transcripts: ScenarioTranscripts,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, `${scenario.name}-${timestamp}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2), 'utf8');
  await writeFile(
    join(dir, 'anthropic.transcript.json'),
    JSON.stringify(transcripts.anthropicTranscript, null, 2),
    'utf8',
  );
  await writeFile(
    join(dir, 'or.transcript.json'),
    JSON.stringify(transcripts.orTranscript, null, 2),
    'utf8',
  );
}

function formatThrown(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

// ----- canUseTool wiring (Phase 6.5a) -----
//
// Two builders that translate the scenario's wire-agnostic `canUseToolPolicy`
// into the two SDKs' wire-specific closure signatures. The shapes diverge in
// two places that scenario authors don't need to think about:
//
//   - **Tool name:** Anthropic sees `mcp__harness__echo`, OR sees `echo`.
//     The lookup keys off the bare name on both sides so the policy declared
//     in the JSON stays SDK-agnostic.
//   - **Deny-payload field:** Anthropic's `PermissionResult.deny.message`
//     vs. OR's `CanUseToolResult.deny.reason`. The scenario's `message` is
//     the canon text (ambiguity call #4) — both sides receive identical
//     bytes, just under each SDK's field name.

function buildAnthropicCanUseTool(scenario: Scenario): AnthropicCanUseTool | undefined {
  const policy = scenario.canUseToolPolicy;
  if (!policy || policy.length === 0) return undefined;
  // Build a `mcp__harness__<bare>` → rule lookup so the prefix doesn't bleed
  // into the scenario JSON. Allow is the default for tools not listed.
  const ruleByPrefixed = new Map<string, (typeof policy)[number]>();
  for (const rule of policy) {
    ruleByPrefixed.set(anthropicToolName(rule.tool), rule);
  }
  return async (toolName, input) => {
    const rule = ruleByPrefixed.get(toolName);
    if (!rule || rule.action === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: rule.message };
  };
}

function buildOrCanUseTool(scenario: Scenario): OrCanUseTool | undefined {
  const policy = scenario.canUseToolPolicy;
  if (!policy || policy.length === 0) return undefined;
  // OR-side tool names are the bare fixture names (no MCP prefix).
  const ruleByName = new Map<string, (typeof policy)[number]>();
  for (const rule of policy) {
    ruleByName.set(rule.tool, rule);
  }
  return (toolName) => {
    const rule = ruleByName.get(toolName);
    if (!rule || rule.action === 'allow') {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', reason: rule.message };
  };
}
