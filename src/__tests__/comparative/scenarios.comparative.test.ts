// `describe.each` driver for the comparative-parity canonical scenario set
// (Phase 6.5a). One row per scenario JSON in `src/__tests__/comparative/scenarios/`.
// Each row:
//   1. Runs the harness in `emulated` mode against the scenario.
//   2. Asserts neither SDK threw at the harness level (transcripts captured
//      with a populated `thrown` field is a harness-level signal that
//      something broke in the plumbing, not a parity result).
//   3. Feeds both transcripts into the 6.4 comparator and asserts
//      `result.pass === true`. This is the parity assertion the canonical
//      set exists to make — anything weaker would silently rot.
//
// The smoke scenario shipped by 6.3 has been removed (ambiguity call #5):
// scenario #1 supersedes it as the canonical "single-turn no-tool" case,
// and the comparator-pass assertion makes the smoke's looser "transcripts
// captured" check redundant.

import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StateAccessor, ConversationState } from '@openrouter/agent';

import { compareTranscriptsFromScenario } from './comparator.js';
import { runScenario } from './harness.js';
import { loadScenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'scenarios');

// Phase 6.8: opt-in per-scenario pass/fail JSONL emission for the nightly
// drift-detection workflow. Default off — local + PR runs don't pay the
// I/O. The nightly workflow sets `COMPARATIVE_EMULATED_RESULT_REPORT` to a
// directory; the driver writes one JSONL line per scenario test, last-
// write-wins on retries (vitest --retry=1 re-invokes the test body, the
// workflow's jq pass dedupes by scenario name). The file is wiped in
// beforeAll so each run starts clean.
const EMULATED_REPORT_DIR = process.env.COMPARATIVE_EMULATED_RESULT_REPORT;
const EMULATED_REPORT_PATH = EMULATED_REPORT_DIR
  ? join(EMULATED_REPORT_DIR, 'comparative-emulated-result-report.jsonl')
  : null;

const scenarios = readdirSync(SCENARIO_DIR)
  // Ignore authoring helpers (`_tools.ts`, `_helper.ts`, `README.md`).
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), path: join(SCENARIO_DIR, f) }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (EMULATED_REPORT_PATH) {
  // Reset the report artifact so each run starts clean. The nightly
  // workflow reads this file after the test command exits.
  beforeAll(async () => {
    await mkdir(dirname(EMULATED_REPORT_PATH), { recursive: true });
    await writeFile(EMULATED_REPORT_PATH, '', 'utf8');
  });
}

describe.each(scenarios)('comparative scenario: $name', ({ name, path }) => {
  // Track this scenario's pass-state across afterEach so we can emit the
  // JSONL line whether the test threw or not. Vitest's --retry=1 re-runs
  // the test body, so afterEach fires again on retry — last-write-wins
  // semantics; the workflow's jq pass dedupes by scenario name.
  let scenarioPassed = false;
  afterEach(async () => {
    if (!EMULATED_REPORT_PATH) return;
    const line =
      JSON.stringify({
        scenario: name,
        mode: 'emulated',
        pass: scenarioPassed,
      }) + '\n';
    await appendFile(EMULATED_REPORT_PATH, line, 'utf8');
  });

  it('passes the comparator in emulated mode', async () => {
    scenarioPassed = false;
    const scenario = await loadScenario(path);
    const { anthropicTranscript, orTranscript } = await runScenario(path, 'emulated');

    // Surface harness-level throws as a test failure with the captured
    // `thrown` text so the developer doesn't have to dig through the
    // failure dump to figure out what crashed. Phase 6.5b cancellation
    // scenarios (#6) deliberately abort both SDKs mid-stream, populating
    // `thrown` with an AbortError; the comparator's `ignoreThrown` carries
    // the parity claim. For those scenarios we still inspect the throw
    // payload so a non-abort error (which would indicate genuine plumbing
    // breakage) still fails the test, but a benign abort path is allowed.
    // Phase 6.6 failure-injection scenarios (#13–#15) ALSO populate `thrown`
    // (transport/parse errors), but with SDK-specific phrasing that isn't
    // abort-shaped — they opt out of the regex check via the
    // `tolerateThrownInjection` flag while still requiring `ignoreThrown`
    // to suppress the no-throw assertion. The flag is intentionally narrow
    // (not a blanket "no defensive check") so non-injection scenarios that
    // misuse it still get caught by the schema's documentation.
    const cancelling = scenario.comparator?.ignoreThrown === true;
    const tolerateInjection = scenario.comparator?.tolerateThrownInjection === true;
    if (!cancelling) {
      expect(
        anthropicTranscript.thrown,
        `Anthropic side threw:\n${anthropicTranscript.thrown}`,
      ).toBeUndefined();
      expect(orTranscript.thrown, `OR side threw:\n${orTranscript.thrown}`).toBeUndefined();
    } else if (!tolerateInjection) {
      // Defensive: confirm the throw, if any, looks abort-flavored — guards
      // against a future regression where the SDK starts throwing for a
      // different reason and the comparator's ignoreThrown silently masks it.
      const ABORT_PATTERN = /abort|cancel/i;
      if (anthropicTranscript.thrown) {
        expect(
          anthropicTranscript.thrown,
          `Anthropic threw a non-abort error:\n${anthropicTranscript.thrown}`,
        ).toMatch(ABORT_PATTERN);
      }
      if (orTranscript.thrown) {
        expect(orTranscript.thrown, `OR threw a non-abort error:\n${orTranscript.thrown}`).toMatch(
          ABORT_PATTERN,
        );
      }
    }
    // tolerateThrownInjection: no shape-check on the throw text — failure-
    // injection scenarios surface SDK-specific transport/parse error
    // phrasing that we explicitly don't compare across SDKs.

    const result = await compareTranscriptsFromScenario(
      scenario,
      anthropicTranscript,
      orTranscript,
      { dumpOnFail: false },
    );

    // On failure, attach the human-readable Markdown report so the
    // diagnostic appears in the test output without requiring a separate
    // dump-file inspection step.
    expect(result.pass, `Comparator failed:\n${result.report}`).toBe(true);

    // Reached only if every expect above held — flag pass for the 6.8
    // nightly JSONL emitted in afterEach.
    scenarioPassed = true;
  });
});

// ----- Scenario #4 hook firing order — load-bearing exact assertion ------
//
// The plan-doc's parity claim is "Hook firing order + event-shape assertions
// stay exact in both modes." Scenario #4 (permission denial) is the case
// where this matters most: a host-side canUseTool deny MUST short-circuit
// the tool dispatch on both SDKs in the SAME spot in the hook stream.
//
// We assert the exact canonical hook order here in addition to the
// comparator pass above, so a future regression that broke the deny path's
// ordering would surface with a precise failure rather than a vague
// "comparator pass=false" message that bundles every other parity check
// with this one. The expected order is hard-coded from the canonical
// canonicalization rules in `canonicalize.ts`.

describe('comparative scenario: 04-permission-denial — hook order', () => {
  it('emits the deny-path hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '04-permission-denial.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const scenario = await loadScenario(scenarioPath);
    const result = await compareTranscriptsFromScenario(
      scenario,
      anthropicTranscript,
      orTranscript,
      { dumpOnFail: false },
    );

    expect(result.pass).toBe(true);

    // Both projections share `hookOrder`; if the comparator passed, they
    // are equal. Pin the exact sequence so a future change that ALSO
    // adjusts the comparator can't silently weaken this contract.
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    const anthHook = canonicalizeAnthropic(anthropicTranscript).hookOrder;
    const orHook = canonicalizeOr(orTranscript).hookOrder;

    const expected = [
      'session_start',
      'turn_start',
      'tool_call:rm',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];

    expect(anthHook).toEqual(expected);
    expect(orHook).toEqual(expected);
  });
});

// ----- Phase 6.5b: exact hook-order pins for canonical scenarios #5–#8 ----
//
// Per the plan doc + issue body, hook firing order is the load-bearing parity
// claim and MUST be asserted exactly on every scenario in the canonical set
// — the comparator's hook_order check already does this, but pinning the
// expected sequences here in addition prevents a future weakening of the
// comparator from silently rotting the contract.

describe('comparative scenario: 05-plan-mode-readonly — hook order', () => {
  it('emits the plan-mode (read passes / write denied) hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '05-plan-mode-readonly.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:read', // read passes the filter, dispatches
      'turn_end',
      'tool_result',
      'turn_start',
      'tool_call:write', // write filtered, short-circuited
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

describe('comparative scenario: 06-cancel-mid-stream — hook order', () => {
  it('emits the cancellation hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '06-cancel-mid-stream.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // Both sides: session → opened-turn (synthesized) → closed-turn (synthesized)
    // → synthetic terminal:aborted. Anthropic's terminal:aborted is emitted by
    // canonicalizeAnthropic when transcript.thrown is set and no `result`
    // arrived; OR's comes from canonicalizeOr's stream_complete{status:error,
    // reason:aborted} → 'aborted' remap.
    const expected = ['session_start', 'turn_start', 'turn_end', 'terminal:aborted'];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

describe('comparative scenario: 07-tool-error-resume — hook order', () => {
  it('emits the throw-and-retry hook sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '07-tool-error-resume.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // Turn 0: tool_call(flakyFetch) → tool_result(isError=true on Anthropic,
    // false on OR per known agent.ts gap documented on the comparator's
    // `tolerateToolResultIsError` flag).
    // Turn 1: retry tool_call → tool_result(isError=false on both).
    // Turn 2: text summary → terminal:success.
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:flakyFetch',
      'turn_end',
      'tool_result',
      'turn_start',
      'tool_call:flakyFetch',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

// Phase 6.5c: scenario #12 retry assertion. The comparator above asserts that
// the canonical event streams match (i.e., the 429+retry is invisible at the
// projection layer); this supplemental check inspects the raw Anthropic
// transcript for `system:api_retry` messages, proving the SDK ACTUALLY
// retried. Without this, the scenario could spuriously "pass" if the SDK had
// some other (unintended) recovery path that bypassed retry but still reached
// terminal:success — the bytes-on-the-wire claim of "the SDK retries 429" is
// the load-bearing finding, and the test must check that bytes-on-the-wire
// directly. The OR side is NOT checked here because its SDK doesn't retry
// 429 by default (see scenario JSON description for the divergence finding).

describe('comparative scenario: 12-retry-on-429 — retry observed', () => {
  it('Anthropic transcript carries at least one api_retry message (proves 429 retry path fired)', async () => {
    const scenarioPath = join(SCENARIO_DIR, '12-retry-on-429.json');
    const { anthropicTranscript } = await runScenario(scenarioPath, 'emulated');
    const apiRetryCount = anthropicTranscript.messages.filter(
      (m) =>
        (m as { type?: string }).type === 'system' &&
        (m as { subtype?: string }).subtype === 'api_retry',
    ).length;
    expect(
      apiRetryCount,
      `Expected at least 1 api_retry message on the Anthropic transcript (proves the SDK retried the scripted 429); got ${apiRetryCount}.`,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('comparative scenario: 08-hook-block-modify — hook order', () => {
  it('emits the hook-block (shell denied before dispatch) sequence in EXACT order on both SDKs', async () => {
    const scenarioPath = join(SCENARIO_DIR, '08-hook-block-modify.json');
    const { anthropicTranscript, orTranscript } = await runScenario(scenarioPath, 'emulated');
    const { canonicalizeAnthropic, canonicalizeOr } = await import('./canonicalize.js');
    // PreToolUse fires (tool_call observed in the stream), dispatch never
    // happens (no execute() entry — the denial short-circuits at canUseTool),
    // tool_result returns isError=true with the canon denial message, model
    // adapts in the next turn.
    const expected = [
      'session_start',
      'turn_start',
      'tool_call:shell',
      'turn_end',
      'tool_result',
      'turn_start',
      'turn_end',
      'terminal:success',
    ];
    expect(canonicalizeAnthropic(anthropicTranscript).hookOrder).toEqual(expected);
    expect(canonicalizeOr(orTranscript).hookOrder).toEqual(expected);
  });
});

// ----- Phase 6.9 backfill #174: persistSession: false — zero-disk-writes -----
//
// The shared `runScenario` harness already constructs the OR side with
// `persistSession: false` (harness.ts:530), so the standard comparator-pass
// run on scenario #18 implicitly exercises the in-memory `StateAccessor`'s
// `previousResponseId` roundtrip: the turn-1 OR request includes
// `previous_response_id: resp-18-0`, which is canonicalized into the
// promptHash; an in-memory accessor that failed to carry the id forward
// would produce a different turn-1 hash and miss the script.
//
// This supplemental test pins the OTHER half of the Phase 3.12 contract: that
// `persistSession: false` produces ZERO filesystem writes under `logsRoot`.
// It builds an OR-only run inline (the Anthropic agent SDK has no equivalent
// `persistSession` knob — its subprocess writes to `~/.claude/projects/`
// under its own bookkeeping, out of scope for this parity claim — see PR
// body ambiguity call #1), drives the same two-turn `write`-tool flow against
// an in-process emulator seeded with scenario #18's OR-wire script entries,
// and asserts the explicit `logsRoot` tmpdir remains EMPTY after the run.
//
// The full-harness `runScenario` would suffice for the previousResponseId
// roundtrip but does NOT thread `logsRoot` through to the OR ctor (it
// defaults to `<cwd>/logs/`, which the harness assumes is unused because
// `persistSession: false` is set). Pinning an explicit `logsRoot` here lets
// the assertion target a known-empty tmpdir without touching the harness
// surface.

describe('comparative scenario: 18-persist-session-false — zero disk writes (OR-only)', () => {
  it('writes nothing under logsRoot when persistSession is false', async () => {
    const { mkdtemp, rm, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { buildHarnessTools } = await import('./scenarios/_tools.js');

    const scenarioPath = join(SCENARIO_DIR, '18-persist-session-false.json');
    const scenario = await loadScenario(scenarioPath);

    const logsRoot = await mkdtemp(join(tmpdir(), 'persist-session-false-'));
    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }
    const tools = buildHarnessTools(scenario.tools ?? []);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `persist-session-false-${Date.now()}`,
        prompt: scenario.prompt,
        baseUrl: emu.url,
        persistSession: false,
        logsRoot,
        signal: ac.signal,
        tools: tools.orTools,
        model: scenario.model,
        instructions: scenario.systemPrompt,
      });
      for await (const _ev of run) {
        // discard — the parity claim above already asserts event-stream
        // correctness; this test's job is the filesystem assertion below.
      }
    } finally {
      await emu.stop();
    }

    // Phase 3.12's contract: nothing under logsRoot. We assert the directory
    // tree is empty (`{ withFileTypes: true, recursive: true }` surfaces
    // both files and any nested dirs the implementation might have created
    // — a passing run leaves the dir we mkdtemp'd above pristine).
    const entries = await readdir(logsRoot, { recursive: true, withFileTypes: true });
    const written = entries.map((e) => (e.parentPath ? `${e.parentPath}/${e.name}` : e.name));
    expect(
      written,
      `persistSession: false must not write under logsRoot; found: ${written.join(', ')}`,
    ).toEqual([]);

    await rm(logsRoot, { recursive: true, force: true });
  });
});

// ----- Phase 6.9 backfill #165: allowed/disallowed-tools rule grammar (OR-only) -----
//
// The shared bilateral comparator-pass on scenario #19 is intentionally vacuous
// (1-turn no-tool) because the harness uses MCP-bridge tools on both sides and
// the scoped-rule grammar only applies to (a) canonical-name OR tools
// (`bash`, `edit_file`) on the OR side and (b) the Claude Agent SDK's
// built-in tools (`Bash`, `Edit`) on the Anthropic side — never to MCP-bridge
// tools. See the scenario JSON description + PR body ambiguity call #1 for the
// full structural rationale.
//
// This supplemental driver carries the load-bearing assertions. It constructs
// an OR-only run inline with canonical-name tools, drives the scripted three-
// tool-call flow through an in-process emulator, and asserts the scoped-rule
// deny shape on both `tool_result(isError=true)` events. The emulator script
// entries for these four OR-wire turns live in the scenario JSON's `script`
// array alongside the bilateral entries — the bilateral run never consumes
// them (different request bodies, different hashes), and this test pulls them
// in by wire-filter the same way #18's supplemental does.
//
// Config posture: `allowedTools: ['Bash(npm *)']` PLUS
// `disallowedTools: ['Bash(rm *)', 'Edit(src/**/*.ts)']`. The spec's literal
// config (`allowedTools: ['Bash(npm *)']` + `disallowedTools:
// ['Edit(src/**/*.ts)']` only) would NOT deny `rm -rf foo` on OR — OR's
// `buildToolFilterCanUseTool` is additive (default-allow on miss), not a
// strict whitelist. The explicit `Bash(rm *)` disallow rule is the minimal
// augmentation that makes the deny outcome observable; see PR body ambiguity
// call #4.

describe('comparative scenario: 19-allowed-disallowed-grammar — rule grammar (OR-only)', () => {
  it('OR denies via tool_result with the matching scoped-rule reason for Bash(rm *) + Edit(src/**/*.ts); allows Bash(npm *)', async () => {
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { tool: orTool } = await import('@openrouter/agent');
    const { z } = await import('zod/v4');

    const scenarioPath = join(SCENARIO_DIR, '19-allowed-disallowed-grammar.json');
    const scenario = await loadScenario(scenarioPath);

    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }

    // Inline canonical-name tools. `bash` and `edit_file` are the
    // canonical names in the OR rule grammar's `TOOL_NAME_LOOKUP`, so rules
    // like `Bash(npm *)` (→ canonical `bash`) and `Edit(src/**/*.ts)`
    // (→ canonical `edit_file`) match these tools. The `execute` return
    // values are canon — `npm install` (the one allowed call) returns 'ok',
    // and the model's text in the closing turn references it. The denied
    // calls never reach `execute` because `canUseTool` short-circuits via
    // `wrapToolWithPermission` in agent.ts.
    const tools = [
      orTool({
        name: 'bash',
        description: 'Runs a shell command. Returns "ok" on success.',
        inputSchema: z.object({ command: z.string() }),
        execute: () => 'ok',
      }),
      orTool({
        name: 'edit_file',
        description: 'Edits a file at the given path. Returns "ok" on success.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: () => 'ok',
      }),
    ];

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    const events: Array<Record<string, unknown>> = [];
    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `allowed-disallowed-grammar-${Date.now()}`,
        prompt: scenario.prompt,
        baseUrl: emu.url,
        persistSession: false,
        signal: ac.signal,
        tools,
        model: scenario.model,
        instructions: scenario.systemPrompt,
        allowedTools: ['Bash(npm *)'],
        disallowedTools: ['Bash(rm *)', 'Edit(src/**/*.ts)'],
      });
      for await (const ev of run) {
        events.push(ev as Record<string, unknown>);
      }
    } finally {
      await emu.stop();
    }

    // Collect tool_call → tool_result pairs by callId so the per-call
    // assertions key off semantic identity (not stream position — a future
    // event-stream tweak that re-orders unrelated events shouldn't break
    // this test).
    type ToolCall = { type: 'tool_call'; callId: string; name: string; input?: unknown };
    type ToolResult = {
      type: 'tool_result';
      callId: string;
      output: unknown;
      isError: boolean;
    };
    const calls = events.filter((e) => e.type === 'tool_call') as ToolCall[];
    const results = events.filter((e) => e.type === 'tool_result') as ToolResult[];
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);

    const resultByCallId = new Map(results.map((r) => [r.callId, r]));
    const callsByCommand: Record<string, ToolCall> = {};
    for (const c of calls) {
      const input = (c.input ?? {}) as Record<string, unknown>;
      const key = typeof input.command === 'string' ? `cmd:${input.command}` : `path:${input.path}`;
      callsByCommand[key] = c;
    }

    // The load-bearing assertion is on the tool_result CONTENT (the canon
    // scoped-rule reason text from `buildToolFilterCanUseTool`), not on the
    // structural `isError` flag. Empirically the OR SDK's `executeRegularTool`
    // catches the synth-deny throw from `wrapToolWithPermission` and emits a
    // `function_call_output` WITHOUT a status field, so agent.ts:1840 sees
    // `out.status === 'incomplete'` as false and the resulting `tool_result`
    // carries `isError: false` despite the canon agent.ts comment at
    // src/agent.ts:2136 claiming `isError: true`. Same gap the comparator's
    // `tolerateToolResultIsError` flag documents on scenario #07 — it
    // applies to canUseTool denials as well, not only user-tool throws. A
    // real fix lives in agent.ts and is out of scope here. The model on
    // both sides still receives the JSON deny payload in the output and
    // can adapt, so the rule-grammar contract (the reason text reaches the
    // model) is intact; only the structural `isError` flag is wrong. The
    // assertion below pins the content; the `isError` shape is documented
    // here rather than asserted.
    //
    // The OR SDK additionally double-wraps the deny error: the OR side's
    // `executeRegularTool` catch arm JSON-stringifies an outer
    // `{"error": <thrown.message>}` envelope around the inner
    // `{"error":"denied by disallowedTools","denied":true}` from
    // `wrapToolWithPermission`. The escape-bytes survive intact, so a
    // `toContain('denied by disallowedTools')` substring check sees the
    // canon reason text verbatim — that is the parity claim this test
    // makes. A literal `'"denied":true'` substring would fail against the
    // outer-wrap escaping and is therefore NOT asserted.

    // ----- (a) Bash('rm -rf foo') — denied by `Bash(rm *)` ---------------
    const rmCall = callsByCommand['cmd:rm -rf foo'];
    expect(rmCall, 'expected a tool_call for bash rm -rf foo').toBeDefined();
    const rmResult = resultByCallId.get(rmCall.callId);
    expect(rmResult, 'expected a tool_result for the rm tool_call').toBeDefined();
    const rmOutput = String(rmResult!.output ?? '');
    expect(rmOutput).toContain('denied by disallowedTools');

    // ----- (b) Bash('npm install') — allowed by `Bash(npm *)` ------------
    const npmCall = callsByCommand['cmd:npm install'];
    expect(npmCall, 'expected a tool_call for bash npm install').toBeDefined();
    const npmResult = resultByCallId.get(npmCall.callId);
    expect(npmResult, 'expected a tool_result for the npm tool_call').toBeDefined();
    expect(npmResult!.isError).toBe(false);
    expect(String(npmResult!.output ?? '')).toContain('ok');

    // ----- (c) Edit('src/foo.ts') — denied by `Edit(src/**/*.ts)` --------
    const editCall = callsByCommand['path:src/foo.ts'];
    expect(editCall, 'expected a tool_call for edit_file src/foo.ts').toBeDefined();
    const editResult = resultByCallId.get(editCall.callId);
    expect(editResult, 'expected a tool_result for the edit tool_call').toBeDefined();
    const editOutput = String(editResult!.output ?? '');
    expect(editOutput).toContain('denied by disallowedTools');
  });
});

// ----- Phase 6.9 backfill #164: enhanced bash tool (OR-only) -----
//
// The shared bilateral comparator-pass on scenario #20 is intentionally vacuous
// (1-turn no-tool) because the load-bearing surface here is the OR-side
// production `bash` tool's spawn-and-supervise machinery (timeout →
// SIGTERM → 250ms grace → SIGKILL; clamp at MAX_TIMEOUT_MS=600_000 firing a
// `warn` notify). The Claude Agent SDK's built-in `Bash` tool runs inside the
// subprocess CLI and is structurally inaccessible from this harness — only
// the model-visible string output reaches the agent SDK's event stream, never
// the exit code / stderr suffix / kill-grace timing. See scenario JSON
// description + PR body ambiguity call #1 for the full structural rationale.
//
// This supplemental driver carries the load-bearing assertions. It constructs
// an OR-only run inline with the production `bashTool()`, drives the
// scripted two-tool-call flow through an in-process emulator, captures
// `Notification` hook events via the run's `onHook` knob, and asserts:
//   (a) timeout: `bash({command:'sleep 5', timeout_ms:100,
//       description:'list build artifacts'})` returns within a generous
//       timing envelope with `exitCode === 1` and `stderr` containing the
//       canonical `terminated by SIG{TERM,KILL}` suffix from
//       bash.ts:139-145.
//   (b) clamp: `bash({command:':', timeout_ms:700000})` runs to
//       completion (the clamp shortens to MAX_TIMEOUT_MS but `:` exits
//       immediately, so no SIGTERM fires) and the `Notification` hook
//       receives the canonical `'bash timeout_ms exceeds
//       MAX_TIMEOUT_MS, clamping'` warn payload from bash.ts:54-57.
//
// The issue body claims `BashResult` carries `truncated: true` +
// `exitCode: null` on the kill path; the ACTUAL production interface at
// bash.ts:11-15 is `{exitCode: number, stdout: string, stderr: string}`
// — no truncated flag, never-null exitCode (the close handler at
// bash.ts:142 resolves `exitCode: code ?? 1`, so it's `1` on signal
// kill, never null). We assert the actually-observable shape; the
// issue-body spec mismatch + TODO for a structural `BashResult`
// extension is documented as PR body ambiguity call #2.
//
// Timing envelope rationale: nominal kill time is 100ms timeout + up to
// 250ms SIGKILL grace = 350ms. CI subprocess spawn + signal delivery jitter
// can add several hundred ms on cold cache. We use a 5_000ms upper bound
// to stay generous against slow CI (the test still surfaces a real
// regression — the production code without kill-on-timeout would let
// `sleep 5` run the full 5s and would time out at the run-level 30s
// AbortController instead).

describe('comparative scenario: 20-enhanced-bash — spawn machinery (OR-only)', () => {
  it('OR bash honors timeout (SIGTERM → SIGKILL grace) and MAX_TIMEOUT_MS clamp warn-notify', async () => {
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { bashTool } = await import('../../tools/bash.js');

    const scenarioPath = join(SCENARIO_DIR, '20-enhanced-bash.json');
    const scenario = await loadScenario(scenarioPath);

    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }

    // Capture every clamp `notify('warn', ...)` event the production tool
    // emits from inside its execute. The wiring is:
    //
    //   - `bash.ts:54-57` calls `ctx.notify?.('warn', ...)` from the
    //     CLOSURE-captured `ToolContext` (the one passed to `bashTool(ctx)`
    //     at factory time), not the SDK-supplied runtime ToolExecuteContext.
    //   - `agent.ts:2224-2231` injects a `notify` onto the RUNTIME ctx (passed
    //     as the 2nd arg to execute) that reroutes through
    //     `safeFireHook('Notification', ...)`. But the bash factory
    //     reads from the closure ctx and ignores the runtime ctx — so the
    //     clamp notify does NOT reach the run's `onHook` in production
    //     through the canonical agent-internal-tools wiring (`allTools(ctx,
    //     ...)` at `tools/index.ts:202` calls `bashTool(ctx)` with a
    //     ctx that has no `notify`, per `agent.ts:1349-1361`). The same
    //     pattern is used by `tools/monitor.ts:86,96`; `tools/tasks.ts:98-102`
    //     and `tools/ask-user-question.ts:99-102` correctly prefer
    //     `execCtx.notify ?? ctx.notify` so they bridge to the Notification
    //     hook. The mismatch is a real production gap (the clamp warn is
    //     intended-but-unreachable through the agent's hook surface today);
    //     fixing it is OUT OF SCOPE for this harness-only PR (ZERO production
    //     touches, per the scope rules). See PR body ambiguity call #4 for
    //     the TODO + a follow-up issue link.
    //
    // To make the clamp-warn assertion observable from this test, we pass
    // notify directly into the closure-captured ctx — the same pattern the
    // production unit test at `tools/bash.test.ts:137` uses. This
    // exercises the tool's internal clamp-and-fire logic (the load-bearing
    // half of the parity claim); the missing-hook-bridge half is documented
    // separately. We also wire `onHook` so a future bridge-fix would
    // surface here (the `notifications` array would receive a duplicate).
    const notifications: Array<{ level: unknown; message: unknown; context: unknown }> = [];
    const captureNotify = async (
      level: 'info' | 'warn' | 'error',
      message: string,
      context?: unknown,
    ) => {
      notifications.push({ level, message, context });
    };
    const onHook = async (event: string, payload: unknown) => {
      if (event !== 'Notification') return;
      const p = payload as { level?: unknown; message?: unknown; context?: unknown };
      notifications.push({ level: p.level, message: p.message, context: p.context });
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    const events: Array<Record<string, unknown>> = [];
    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `enhanced-bash-${Date.now()}`,
        prompt: scenario.prompt,
        baseUrl: emu.url,
        persistSession: false,
        signal: ac.signal,
        // Production tool — this test's load-bearing claim is on its real
        // spawn/supervise behavior (timeout → SIGTERM → 250ms grace →
        // SIGKILL; MAX_TIMEOUT_MS clamp). Construct with a closure ctx that
        // carries `notify` so the clamp-warn fires (see note above for why
        // the production agent-wired path can't reach the Notification hook
        // for this tool today).
        tools: [bashTool({ cwd: '.', notify: captureNotify })],
        model: scenario.model,
        instructions: scenario.systemPrompt,
        onHook,
      });
      for await (const ev of run) {
        events.push(ev as Record<string, unknown>);
      }
    } finally {
      await emu.stop();
    }

    type ToolCall = { type: 'tool_call'; callId: string; name: string; input?: unknown };
    type ToolResult = {
      type: 'tool_result';
      callId: string;
      output: unknown;
      isError: boolean;
    };
    const calls = events.filter((e) => e.type === 'tool_call') as ToolCall[];
    const results = events.filter((e) => e.type === 'tool_result') as ToolResult[];
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);

    const resultByCallId = new Map(results.map((r) => [r.callId, r]));

    // ----- (a) timeout: sleep 5 with timeout_ms=100 ----------------------
    const sleepCall = calls.find((c) => {
      const input = (c.input ?? {}) as Record<string, unknown>;
      return input.command === 'sleep 5';
    });
    expect(sleepCall, 'expected a tool_call for bash sleep 5').toBeDefined();

    // description advisory round-trips through the model-emitted args into
    // the canonical tool_call.input event. The issue body's broader claim of
    // "propagates into the canonical request log" is observable only via a
    // recorded per-request log artifact — `persistSession: false` here, so
    // we assert the observable half (PR body ambiguity call #3).
    const sleepInput = (sleepCall!.input ?? {}) as Record<string, unknown>;
    expect(sleepInput.description).toBe('list build artifacts');
    expect(sleepInput.timeout_ms).toBe(100);

    const sleepResult = resultByCallId.get(sleepCall!.callId);
    expect(sleepResult, 'expected a tool_result for the sleep tool_call').toBeDefined();
    // The agent serializes `BashResult` to a JSON string for the
    // `function_call_output` payload (so the model sees text, not a structured
    // object). Parse it back to a structured shape for the per-field
    // assertions below.
    const sleepOutput = JSON.parse(String(sleepResult!.output ?? '{}')) as {
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    // Spec mismatch: the issue body claims `{truncated: true, exitCode: null}`
    // but the actual production interface at bash.ts:11-15 is
    // `{exitCode: number, stdout: string, stderr: string}` — never null, no
    // truncated flag. Assert the actually-observable shape. See PR body
    // ambiguity call #2.
    expect(sleepOutput.exitCode).toBe(1);
    expect(typeof sleepOutput.stdout).toBe('string');
    expect(typeof sleepOutput.stderr).toBe('string');
    // The close handler at bash.ts:139-145 appends `terminated by
    // SIGTERM` or `terminated by SIGKILL` depending on which signal won the
    // race. On a 100ms timeout against `sleep 5`, SIGTERM almost always
    // wins (sleep responds to SIGTERM immediately); the SIGKILL branch
    // fires only when SIGTERM is ignored within the 250ms grace. Accept
    // either suffix — both prove the kill-on-timeout path fired.
    const stderr = String(sleepOutput.stderr ?? '');
    expect(
      stderr.includes('terminated by SIGTERM') || stderr.includes('terminated by SIGKILL'),
      `expected stderr to contain SIGTERM/SIGKILL suffix, got: ${JSON.stringify(stderr)}`,
    ).toBe(true);

    // ----- (b) clamp: timeout_ms=700_000 against `:` ---------------------
    const clampCall = calls.find((c) => {
      const input = (c.input ?? {}) as Record<string, unknown>;
      return input.command === ':';
    });
    expect(clampCall, 'expected a tool_call for bash :').toBeDefined();
    const clampInput = (clampCall!.input ?? {}) as Record<string, unknown>;
    expect(clampInput.timeout_ms).toBe(700000);

    const clampResult = resultByCallId.get(clampCall!.callId);
    expect(clampResult, 'expected a tool_result for the clamp tool_call').toBeDefined();
    const clampOutput = JSON.parse(String(clampResult!.output ?? '{}')) as {
      exitCode?: unknown;
    };
    // `:` exits 0 immediately, well before MAX_TIMEOUT_MS expires. No
    // SIGTERM fires — the clamp warn-notify fires synchronously (before
    // spawn), then the spawn runs to completion.
    expect(clampOutput.exitCode).toBe(0);

    // The clamp warn-notify is the canon assertion for this sub-case. The
    // production payload at bash.ts:54-57 is `{requestedMs: 700000,
    // effectiveMs: 600000}`; the agent's wrapToolWithHooks closure forwards
    // it verbatim into the Notification hook.
    const clampWarn = notifications.find(
      (n) =>
        n.level === 'warn' &&
        typeof n.message === 'string' &&
        n.message === 'bash timeout_ms exceeds MAX_TIMEOUT_MS, clamping',
    );
    expect(
      clampWarn,
      `expected a clamp warn-notify; got: ${JSON.stringify(notifications)}`,
    ).toBeDefined();
    const clampCtx = (clampWarn!.context ?? {}) as Record<string, unknown>;
    expect(clampCtx.requestedMs).toBe(700000);
    expect(clampCtx.effectiveMs).toBe(600000);
  });
});

// ----- Phase 6.9 backfill #160: NotebookEdit tool (OR-only) -----
//
// The shared bilateral comparator-pass on scenario #21 is intentionally vacuous
// (1-turn no-tool) because the harness uses MCP-bridge tools on both sides and
// the production `edit_notebook` tool has no MCP analogue registered on the
// Anthropic side — the Claude Agent SDK's built-in `NotebookEdit` runs inside
// the subprocess CLI and is structurally inaccessible from the agent SDK's
// user-facing event stream. Same posture as PR #190 / #191 / #192. See the
// scenario JSON description + PR body ambiguity call #1 for the full
// structural rationale.
//
// This supplemental driver carries the load-bearing assertions. It constructs
// an OR-only run inline with the production `editNotebookTool({cwd: tmpDir})`,
// writes a fixture `.ipynb` into the tmpdir (PR body ambiguity call #2 —
// inline vs checked-in fixture file), drives a six-tool-call flow through an
// in-process emulator (four valid ops + two scripted validation errors), and
// asserts:
//   (a) the four valid operations each return `{ok: true, cells: <count>}`
//       with the expected count progression (2 → 2 → 3 → 3 → 2 once the
//       validation arms are interleaved);
//   (b) the two validation-error operations return `{error: <exact-message>}`
//       from the production validation arms at
//       `src/tools/edit-notebook.ts:104-119`;
//   (c) the final on-disk notebook has every cell's `source` as `string[]`
//       (proves `stringToSourceArray` at `src/tools/edit-notebook.ts:39-49`
//       ran on every successful write — including the code→markdown
//       `change_type` arm that runs `stringToSourceArray(sourceToString(...))`
//       on `target.source` rather than blindly trusting the prior shape);
//   (d) `change_type` from code→markdown drops `outputs` + `execution_count`,
//       and `insert` of a markdown cell creates one WITHOUT those keys (per
//       the production code at `src/tools/edit-notebook.ts:156-167` /
//       `:131-134`).
//
// Validation-error coverage lives in this same scenario (PR body ambiguity
// call #3) — splitting it into a separate scenario would duplicate the
// fixture-setup machinery for no observable parity gain. Source-normalization
// is asserted on the FS post-write state (ambiguity call #4) rather than on
// each tool-result payload because the on-disk shape is the load-bearing
// contract: the tool result only carries `{ok, cells}`, never the cells
// themselves. All four operations run in one scenario (ambiguity call #5) —
// splitting per-operation would multiply the OR script-entry count without
// adding coverage. The `change_type` operation's required-fields shape
// (`new_cell_type` only — `new_source` is NOT required because the code
// preserves the cell's current source via `stringToSourceArray(sourceToString(
// target.source))` at `src/tools/edit-notebook.ts:155`) was verified by
// reading the production code, not the spec doc (ambiguity call #6).

describe('comparative scenario: 21-notebook-edit — four operations + validation (OR-only)', () => {
  it('OR edit_notebook runs all four operations, surfaces validation errors, and normalizes source to string[] on every write', async () => {
    const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { editNotebookTool } = await import('../../tools/edit-notebook.js');

    const scenarioPath = join(SCENARIO_DIR, '21-notebook-edit.json');
    const scenario = await loadScenario(scenarioPath);

    const workDir = await mkdtemp(join(tmpdir(), 'notebook-edit-'));
    // Initial fixture: 2 cells. Cell 0's `source` is a STRING (not a
    // `string[]`) on purpose — the post-run final-state assertion proves
    // `stringToSourceArray` ran on the `replace_source` + `change_type` arms
    // that touch it. Cell 1's `source` is already a `string[]` so the
    // delete-arm doesn't matter for normalization, but the surviving cell
    // (after delete) is the inserted one whose source is freshly normalized.
    const initialNotebook = {
      cells: [
        {
          cell_type: 'code',
          source: 'print(1)\nprint(2)',
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: 'markdown',
          source: ['# Intro\n', '\n', 'Body.'],
          metadata: {},
        },
      ],
      metadata: { kernelspec: { name: 'python3' } },
    };
    await writeFile(join(workDir, 'fixture.ipynb'), JSON.stringify(initialNotebook), 'utf-8');

    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    const events: Array<Record<string, unknown>> = [];
    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `notebook-edit-${Date.now()}`,
        prompt: scenario.prompt,
        baseUrl: emu.url,
        persistSession: false,
        signal: ac.signal,
        // Production tool — load-bearing claim is on its real operation
        // arms + source-normalization semantics. The closure ctx's `cwd` is
        // the tmpdir, so the model's scripted `path: "fixture.ipynb"`
        // resolves to the actual fixture file we wrote above.
        tools: [editNotebookTool({ cwd: workDir })],
        model: scenario.model,
        instructions: scenario.systemPrompt,
      });
      for await (const ev of run) {
        events.push(ev as Record<string, unknown>);
      }
    } finally {
      await emu.stop();
    }

    type ToolCall = { type: 'tool_call'; callId: string; name: string; input?: unknown };
    type ToolResult = {
      type: 'tool_result';
      callId: string;
      output: unknown;
      isError: boolean;
    };
    const calls = events.filter((e) => e.type === 'tool_call') as ToolCall[];
    const results = events.filter((e) => e.type === 'tool_result') as ToolResult[];
    expect(calls).toHaveLength(6);
    expect(results).toHaveLength(6);

    const resultByCallId = new Map(results.map((r) => [r.callId, r]));

    const parseOutput = (callId: string): Record<string, unknown> => {
      const r = resultByCallId.get(callId);
      expect(r, `expected tool_result for callId ${callId}`).toBeDefined();
      return JSON.parse(String(r!.output ?? '{}')) as Record<string, unknown>;
    };

    // ----- (a) replace_source on cell 0 — expect ok, cells=2 -------------
    const replaceOut = parseOutput('call_replace_0');
    expect(replaceOut.ok).toBe(true);
    expect(replaceOut.cells).toBe(2);

    // ----- (b) replace_source missing new_source — validation error -----
    // Production arm at `src/tools/edit-notebook.ts:104-106`.
    const replaceMissingOut = parseOutput('call_replace_missing_1');
    expect(replaceMissingOut.error).toBe('replace_source requires new_source');

    // ----- (c) insert missing new_cell_type — validation error ----------
    // Production arm at `src/tools/edit-notebook.ts:118-120`. Note the
    // production code checks `new_source` BEFORE `new_cell_type`, so the
    // scripted args include a valid `new_source` to make the missing
    // `new_cell_type` arm the one that fires.
    const insertMissingOut = parseOutput('call_insert_missing_2');
    expect(insertMissingOut.error).toBe('insert requires new_cell_type');

    // ----- (d) insert markdown at idx 2 — expect ok, cells=3 ------------
    const insertOut = parseOutput('call_insert_3');
    expect(insertOut.ok).toBe(true);
    expect(insertOut.cells).toBe(3);

    // ----- (e) change_type code→markdown on cell 0 — expect ok, cells=3
    const changeTypeOut = parseOutput('call_change_type_4');
    expect(changeTypeOut.ok).toBe(true);
    expect(changeTypeOut.cells).toBe(3);

    // ----- (f) delete cell 1 (the original markdown intro) — cells=2 ----
    const deleteOut = parseOutput('call_delete_5');
    expect(deleteOut.ok).toBe(true);
    expect(deleteOut.cells).toBe(2);

    // ----- Post-run on-disk state -------------------------------------
    // The load-bearing source-normalization assertion. After ops a/d/e ran,
    // EVERY surviving cell's `source` must be a `string[]` — including
    // cell 0 (originally a STRING) which got rewritten by `replace_source`
    // and then `change_type`'d, and the inserted markdown cell from op d.
    type FinalNotebookCell = {
      cell_type: string;
      source: string | string[];
      outputs?: unknown;
      execution_count?: unknown;
    };
    const finalRaw = await readFile(join(workDir, 'fixture.ipynb'), 'utf-8');
    const finalNotebook = JSON.parse(finalRaw) as { cells: FinalNotebookCell[] };
    expect(finalNotebook.cells).toHaveLength(2);

    for (const cell of finalNotebook.cells) {
      expect(
        Array.isArray(cell.source),
        `expected cell.source to be string[] (post-write normalization); got ${typeof cell.source}: ${JSON.stringify(cell.source)}`,
      ).toBe(true);
    }

    // Cell 0 is the original code cell that was replace_source'd
    // ("x=1\ny=2\n") then change_type'd to markdown. `stringToSourceArray`
    // splits "x=1\ny=2\n" into ["x=1\n", "y=2\n"]; the change_type arm
    // re-runs `stringToSourceArray(sourceToString(...))` which is a no-op
    // on an already-canonical array. Markdown cells must NOT carry
    // `outputs` / `execution_count` (the code→markdown arm at
    // `src/tools/edit-notebook.ts:156-160` deletes them).
    expect(finalNotebook.cells[0].cell_type).toBe('markdown');
    expect((finalNotebook.cells[0].source as string[]).join('')).toBe('x=1\ny=2\n');
    expect(Object.hasOwn(finalNotebook.cells[0], 'outputs')).toBe(false);
    expect(Object.hasOwn(finalNotebook.cells[0], 'execution_count')).toBe(false);

    // Cell 1 is the inserted markdown cell ("# Tail\n\nEnd."). The
    // production code at `src/tools/edit-notebook.ts:126-134` creates a
    // markdown cell WITHOUT `outputs` / `execution_count` (those are only
    // added in the `cell_type === 'code'` arm).
    expect(finalNotebook.cells[1].cell_type).toBe('markdown');
    expect((finalNotebook.cells[1].source as string[]).join('')).toBe('# Tail\n\nEnd.');
    expect(Object.hasOwn(finalNotebook.cells[1], 'outputs')).toBe(false);
    expect(Object.hasOwn(finalNotebook.cells[1], 'execution_count')).toBe(false);

    await rm(workDir, { recursive: true, force: true });
  });
});

// ----- Phase 6.9 backfill #156: streaming input + host-interrupt (OR-only) -----
//
// POSTURE — OR-only-asserts (PR body ambiguity call #1). Streaming input
// (`prompt: AsyncIterable<UserInput>`, Phase 5.3) and the run's between-turn
// `interrupt()` facade have NO Anthropic analog reachable through this harness:
// the shared `runScenario` harness constructs BOTH SDKs with a single string
// `prompt` (harness.ts) and exposes neither an `AsyncIterable` prompt nor an
// `interrupt()`/`pushUserMessage()` surface on the Anthropic `query()` side.
// The bilateral comparator-pass on scenario #22 therefore carries only the
// 1-turn no-tool event-stream floor; this OR-only supplemental carries the
// load-bearing streaming-input + interrupt assertions, against the SAME
// in-process emulator the bilateral run uses. Same posture as PRs #190–#192.
//
// MECHANISM. The supplemental drives a real `OpenRouterAgentRun` with
// `prompt: AsyncIterable<UserInput>` yielding THREE messages, against the
// emulator seeded with scenario #22's three `openresponses` streaming entries.
// The interrupt is injected deterministically via a wrapper `StateAccessor`:
//
//   - The `@openrouter/agent` SDK only polls the host interrupt flag at the
//     `checkForInterruption` call INSIDE its tool-execution loop
//     (model-result.js:1058) — a no-tool response completes in one turn and
//     never reaches that poll. So cycle 2's scripted response carries BOTH
//     text AND a `tool_use` block, which makes the SDK enter the loop. The
//     tool call is the load-bearing mechanism that makes the interrupt
//     observable, not incidental (PR body ambiguity call #2).
//   - The wrapper detects that exact poll — the first `load()` where status is
//     `'in_progress'` and a `function_call` is pending with no matching
//     `function_call_output` — and calls the PRODUCTION `setInterruptedFlag`
//     (src/streaming-input.ts) to write `interruptedBy='host-interrupt'`,
//     returning the flagged state so the SDK's own checkForInterruption exits
//     cycle 2 with `status:'interrupted'` + `partialResponse`. One-shot — the
//     SDK's cycle-start handler clears the flag (model-result.js:798) so cycle
//     3 runs clean.
//   - The interrupt is injected via the wrapper invoking `setInterruptedFlag`
//     rather than `run.interrupt()` directly because `interrupt()` awaits the
//     in-flight cycle promise, which deadlocks when called from inside the
//     consumer's `for await` (PR body ambiguity call #3). `setInterruptedFlag`
//     is exactly what `interrupt()` calls internally to write the flag, so the
//     state projection asserted here is faithful to the public API.
//
// FINDING (not fixed here — ZERO production touches). The SDK's
// checkForInterruption persists `{status:'interrupted', partialResponse}` by
// merging onto its in-memory `currentState` (cached at cycle start, before the
// host wrote the flag), so the persisted interrupted state does NOT retain
// `interruptedBy`. The agent loop's post-cycle `stateAfter.interruptedBy` read
// (src/agent.ts:2040) consequently falls back to the literal `'interrupted'`
// for `stream_complete.reason` rather than `'host-interrupt'` on a run whose
// LAST cycle was the interrupted one. This run's last cycle (3) completes
// cleanly so `reason` is absent regardless; the divergence is documented in
// the PR body as a follow-up, not a blocker for this assertion.

describe('comparative scenario: 22-streaming-input-interrupt — streaming input + host-interrupt (OR-only)', () => {
  it('admits three user messages, exits cycle 2 interrupted with partialResponse, and commits it before cycle 3', async () => {
    const { startEmulator } = await import('./emulator/index.js');
    const { OpenRouterAgentRun } = await import('../../agent.js');
    const { createMemoryStateAccessor } = await import('../../state/memory-state.js');
    const { setInterruptedFlag } = await import('../../streaming-input.js');
    const { canonicalizeOr } = await import('./canonicalize.js');
    const { tool: orTool } = await import('@openrouter/agent');
    const { z } = await import('zod/v4');

    type StateLike = {
      status?: string;
      messages?: Array<{ type?: string; role?: string; content?: unknown }>;
      interruptedBy?: string;
      partialResponse?: { text?: string };
    };

    const scenarioPath = join(SCENARIO_DIR, '22-streaming-input-interrupt.json');
    const scenario = await loadScenario(scenarioPath);

    const emu = await startEmulator();
    for (const entry of scenario.script) {
      if ((entry.wire ?? 'anthropic') !== 'openresponses') continue;
      emu.registry.register(entry as Parameters<typeof emu.registry.register>[0]);
    }

    // (a) Record each admitted user message: the trailing role:'user' item in
    // every callModel request body's `input`. One per cycle → three admissions.
    const admitted: string[] = [];
    const originalLookup = emu.registry.lookup.bind(emu.registry);
    (emu.registry as { lookup: typeof originalLookup }).lookup = (body, wire) => {
      const input = (body as { input?: Array<{ role?: string; content?: unknown }> }).input;
      if (Array.isArray(input)) {
        const lastUser = [...input].reverse().find((m) => m && m.role === 'user');
        if (lastUser && typeof lastUser.content === 'string') admitted.push(lastUser.content);
      }
      return originalLookup(body, wire);
    };

    const inner = createMemoryStateAccessor();
    let fired = false;
    let observedInterruptedBy: string | undefined;
    let interruptedSave: { status?: string; partialText?: string } | undefined;
    let toolExecuted = false;

    const wrapped: StateAccessor = {
      load: async () => {
        const s = (await inner.load()) as (StateLike & ConversationState) | null;
        if (!fired && s && s.status === 'in_progress') {
          const msgs = s.messages ?? [];
          const pendingTool =
            msgs.some((m) => m.type === 'function_call') &&
            !msgs.some((m) => m.type === 'function_call_output');
          if (pendingTool) {
            fired = true;
            // Host-side interrupt at the exact between-turns poll. Production
            // code writes the flag; the SDK observes it on this same load.
            await setInterruptedFlag(inner, 'host-interrupt');
            const flagged = (await inner.load()) as (StateLike & ConversationState) | null;
            observedInterruptedBy = (flagged as StateLike | null)?.interruptedBy;
            return flagged;
          }
        }
        return s;
      },
      save: async (s) => {
        const st = s as StateLike & ConversationState;
        if (st.status === 'interrupted' && st.partialResponse && interruptedSave === undefined) {
          interruptedSave = { status: st.status, partialText: st.partialResponse.text };
        }
        await inner.save(s);
      },
    };

    async function* prompt(): AsyncGenerator<{ content: string }> {
      yield { content: 'MESSAGE_ONE' };
      yield { content: 'MESSAGE_TWO' };
      yield { content: 'MESSAGE_THREE' };
    }

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30_000).unref();

    const events: Array<Record<string, unknown>> = [];
    try {
      const run = new OpenRouterAgentRun({
        apiKey: 'sk-or-emulator-stub',
        sessionId: `streaming-input-interrupt-${Date.now()}`,
        prompt: prompt(),
        baseUrl: emu.url,
        persistSession: false,
        signal: ac.signal,
        // `echo` mirrors the shared `_tools.ts` fixture's name/description/schema
        // so the scripted cycle-2/cycle-3 promptHashes match the request bodies.
        tools: [
          orTool({
            name: 'echo',
            description:
              'Echoes the given text back to the caller. Deterministic, no side effects.',
            inputSchema: z.object({ text: z.string() }),
            execute: ({ text }) => {
              toolExecuted = true;
              return text;
            },
          }),
        ],
        model: scenario.model,
        instructions: scenario.systemPrompt,
      });
      // Swap in the interrupt-injecting accessor before iteration begins (the
      // agent reads `this.stateAccessor` lazily inside `iterate()`). Same
      // reflection pattern the Phase 5.3 unit tests use (agent.streaming.test.ts).
      (run as unknown as { stateAccessor: StateAccessor }).stateAccessor = wrapped;
      for await (const ev of run) {
        events.push(ev as Record<string, unknown>);
      }
    } finally {
      await emu.stop();
    }

    // ----- (a) three distinct user-message admissions --------------------
    expect(admitted).toEqual(['MESSAGE_ONE', 'MESSAGE_TWO', 'MESSAGE_THREE']);
    // ...and the canonical OR event stream shows three turn brackets, one
    // reply per admitted message (cycle 2's reply is the partial text).
    const projection = canonicalizeOr({
      wire: 'openrouter',
      events: events as never,
      costUsd: 0,
    });
    expect(projection.events.filter((e) => e.type === 'turn_start')).toHaveLength(3);
    expect(
      projection.events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { type: 'text'; text: string }).text),
    ).toEqual(['REPLY_ONE', 'REPLY_TWO_PARTIAL', 'REPLY_THREE']);

    // ----- (b) host-interrupt → state.interruptedBy + interrupted exit ----
    expect(observedInterruptedBy).toBe('host-interrupt');
    expect(interruptedSave, 'expected an interrupted state save').toBeDefined();
    expect(interruptedSave!.status).toBe('interrupted');
    expect(interruptedSave!.partialText).toBe('REPLY_TWO_PARTIAL');
    // The interrupt short-circuits the in-flight tool round — echo never runs.
    expect(toolExecuted).toBe(false);

    // ----- (c) next cycle commits partialResponse.text as an assistant msg
    const finalState = (await inner.load()) as StateLike | null;
    expect(finalState).not.toBeNull();
    const msgs = finalState!.messages ?? [];
    // commitPartialResponse (src/streaming-input.ts) appends a plain-STRING
    // -content assistant message; the SDK-persisted responses carry block-array
    // content, so the committed partial is uniquely the string-content one.
    const committedIdx = msgs.findIndex(
      (m) => m.role === 'assistant' && m.content === 'REPLY_TWO_PARTIAL',
    );
    expect(
      committedIdx,
      'expected a committed string-content assistant message carrying the partial text',
    ).toBeGreaterThanOrEqual(0);
    // It lands BEFORE cycle 3's reply enters history.
    const cycle3Idx = msgs.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        JSON.stringify(m.content).includes('REPLY_THREE'),
    );
    expect(cycle3Idx).toBeGreaterThan(committedIdx);
    // partialResponse cleared after the commit.
    expect(finalState!.partialResponse).toBeUndefined();

    // The run completed cleanly — the last cycle (3) was not interrupted.
    const complete = events.at(-1) as { type: string; status: string };
    expect(complete.type).toBe('stream_complete');
    expect(complete.status).toBe('success');
  });
});
