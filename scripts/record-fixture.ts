// Live-recording harness for integration fixtures (Phase 3.3.5).
//
// Runs the real @openrouter/agent SDK against the OpenRouter API and writes a
// JSON fixture in the grammar expected by
// src/__tests__/integration/mock-openrouter.ts. The mock + full-run.test.ts
// are NEVER modified — this script adapts to their grammar, not the other way
// around.
//
// Usage:
//   npm run record:fixture -- --name=<n> --scenario=<file> [--model=<id>]
//
// Lives in scripts/ (not src/) so it's free to use process.env / console.* /
// process.exit — it is dev tooling, not library code.

import {
  OpenRouter,
  stepCountIs,
  maxCost,
  isToolCallOutputEvent,
  tool,
  type Tool,
  type ResponseStreamEvent,
} from '@openrouter/agent';
import { z } from 'zod/v4';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const DEFAULT_MAX_TURNS = 5;
const DEFAULT_MAX_COST_USD = 0.5;
const FIXTURES_DIR = 'src/__tests__/integration/fixtures';
const SENSITIVE_KEYS = new Set(['apiKey', 'authorization', 'Authorization']);
const API_KEY_LEAK_PATTERN = /sk-or-[A-Za-z0-9_-]+/;

interface ScenarioFile {
  name?: string;
  prompt: string;
  /** Tool names from the recorder's registry. Defaults to `[]`. */
  tools?: string[];
  /** Optional system instructions. */
  instructions?: string;
  /** Optional model override (CLI `--model` wins over this). */
  model?: string;
  /** Optional turn cap. Defaults to 5. */
  maxTurns?: number;
  /** Optional cost cap in USD. Defaults to 0.50. */
  maxCostUsd?: number;
}

interface CliArgs {
  name: string;
  scenario: string;
  model?: string;
}

// Mirrors the FixtureStep union in mock-openrouter.ts. Kept as a local type
// so the recorder does not import test-only code.
type FixtureStep =
  | { type: 'yield'; event: unknown }
  | { type: 'tool_execute'; toolName: string; input: unknown; callId: string }
  | { type: 'invoke_turn_end' };

interface Fixture {
  name: string;
  steps: FixtureStep[];
  response?: {
    id?: string;
    model?: string;
    usage?: unknown;
    output?: unknown;
  };
}

// ── tool registry ──────────────────────────────────────────────────────────
// Scenarios reference tools by name; the registry maps names to concrete
// implementations. Tools here intentionally mirror the test stubs in
// src/__tests__/integration/full-run.test.ts so a recorded fixture replays
// against the same tool signatures the test expects.

function makeEchoTool(): Tool {
  return tool({
    name: 'echo',
    description: 'Returns its `value` input prefixed with "echoed:". Use exactly once when asked.',
    inputSchema: z.object({
      value: z.string().describe('The string to echo back'),
    }),
    execute: async ({ value }) => `echoed:${value}`,
  });
}

function makeBashTool(): Tool {
  return tool({
    name: 'bash',
    description:
      'Runs a shell command and returns its output. Use exactly once when asked, then stop.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run'),
    }),
    execute: async ({ command }) => `ran:${command}`,
  });
}

const TOOL_REGISTRY: Record<string, () => Tool> = {
  echo: makeEchoTool,
  bash: makeBashTool,
};

function buildTools(names: readonly string[]): Tool[] {
  return names.map((n) => {
    const factory = TOOL_REGISTRY[n];
    if (!factory) {
      throw new Error(
        `Unknown tool "${n}" in scenario. Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
      );
    }
    return factory();
  });
}

// ── env / cli ──────────────────────────────────────────────────────────────

function loadEnvLocal(): void {
  const envPath = join(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function usage(): never {
  console.error(
    'Usage: npm run record:fixture -- --name=<output-name> --scenario=<path/to/scenario.json> [--model=<openrouter-model-id>]',
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z][a-zA-Z0-9-]*)=(.*)$/);
    if (!m) {
      console.error(`Unrecognized argument: ${arg}`);
      usage();
    }
    const key = m[1];
    const value = m[2];
    if (key === 'name') out.name = value;
    else if (key === 'scenario') out.scenario = value;
    else if (key === 'model') out.model = value;
    else {
      console.error(`Unknown flag: --${key}`);
      usage();
    }
  }
  if (!out.name || !out.scenario) usage();
  return out as CliArgs;
}

// ── sanitization ───────────────────────────────────────────────────────────

function sanitizingReplacer(key: string, value: unknown): unknown {
  if (key && SENSITIVE_KEYS.has(key)) return '[REDACTED]';
  return value;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error(
      'OPENROUTER_API_KEY is required. Set it in .env.local or your shell environment.',
    );
    process.exit(1);
  }

  const scenarioPath = isAbsolute(args.scenario)
    ? args.scenario
    : resolve(process.cwd(), args.scenario);
  if (!existsSync(scenarioPath)) {
    console.error(`Scenario file not found: ${scenarioPath}`);
    process.exit(1);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as ScenarioFile;
  if (typeof scenario.prompt !== 'string' || !scenario.prompt.trim()) {
    console.error(`Scenario ${scenarioPath} is missing a non-empty "prompt" string.`);
    process.exit(1);
  }

  const model = args.model ?? scenario.model ?? DEFAULT_MODEL;
  const maxTurns = scenario.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxCostUsd = scenario.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const tools = buildTools(scenario.tools ?? []);
  const baseUrl = process.env.OPENROUTER_BASE_URL;

  console.log(`Recording fixture "${args.name}" with model "${model}"…`);
  console.log(`  prompt:      ${JSON.stringify(scenario.prompt)}`);
  console.log(`  tools:       [${(scenario.tools ?? []).join(', ')}]`);
  console.log(`  max turns:   ${maxTurns}`);
  console.log(`  max cost:    $${maxCostUsd}`);

  const client = new OpenRouter({
    apiKey,
    ...(baseUrl ? { serverURL: baseUrl } : {}),
    appTitle: 'openrouter-agent-harness/recorder',
  } as ConstructorParameters<typeof OpenRouter>[0]);

  const steps: FixtureStep[] = [];

  // The mock synthesizes `tool.call_output` events at replay time from
  // `tool_execute` steps; recording the SDK's real `tool.call_output` would
  // cause double-emission. We rely on the `response.output_item.done` event
  // (item.type === 'function_call') to know when to inject a `tool_execute`.
  const result = client.callModel({
    model,
    input: [{ role: 'user' as const, content: scenario.prompt }],
    ...(scenario.instructions ? { instructions: scenario.instructions } : {}),
    tools,
    stopWhen: [stepCountIs(maxTurns), maxCost(maxCostUsd)],
    onTurnEnd: async () => {
      steps.push({ type: 'invoke_turn_end' });
    },
  });

  for await (const rawEvent of result.getFullResponsesStream()) {
    const event = rawEvent as ResponseStreamEvent;

    // DROP: mock synthesizes this from tool_execute. Recording it would
    // double-emit at replay time.
    if (isToolCallOutputEvent(event)) continue;

    // tool.preliminary_result / tool.result are SDK-internal aggregations the
    // mock-openrouter grammar doesn't model. Drop them — agent.ts ignores them
    // too (it switches on isToolCallOutputEvent / isTurnStartEvent /
    // isTurnEndEvent / response.output_text.delta / response.output_item.done).
    const evType = (event as { type?: string }).type;
    if (evType === 'tool.preliminary_result' || evType === 'tool.result') continue;

    if (evType === 'response.output_item.done') {
      const item = (event as { item?: { type?: string } }).item;
      if (item && item.type === 'function_call') {
        const fn = item as unknown as {
          type: 'function_call';
          callId: string;
          name: string;
          arguments: string;
        };
        // Emit the yield first (so the consumer sees the function_call
        // announcement event, matching real SDK ordering)…
        steps.push({ type: 'yield', event });
        // …then inject the synthetic tool_execute the mock uses to drive
        // tool resolution + a tool.call_output emission at replay time.
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(fn.arguments);
        } catch {
          parsedInput = fn.arguments;
        }
        steps.push({
          type: 'tool_execute',
          toolName: fn.name,
          input: parsedInput,
          callId: fn.callId,
        });
        continue;
      }
    }

    steps.push({ type: 'yield', event });
  }

  const response = await result.getResponse();
  const fixture: Fixture = {
    name: args.name,
    steps,
    response: {
      id: response.id,
      model: response.model,
      usage: response.usage as unknown,
      output: response.output as unknown,
    },
  };

  const json = JSON.stringify(fixture, sanitizingReplacer, 2);
  if (API_KEY_LEAK_PATTERN.test(json)) {
    throw new Error(
      'Refusing to write fixture: an `sk-or-*` substring is present in the serialized JSON. ' +
        'Inspect the recorded SDK output before continuing.',
    );
  }

  const outPath = join(process.cwd(), FIXTURES_DIR, `${args.name}.json`);
  writeFileSync(outPath, json + '\n');

  const turnEndSteps = steps.filter((s) => s.type === 'invoke_turn_end').length;
  const toolExecuteSteps = steps.filter((s) => s.type === 'tool_execute').length;
  const usage = response.usage as { totalTokens?: number; cost?: number } | undefined;
  console.log(`Wrote ${outPath}`);
  console.log(
    `  ${steps.length} steps (${toolExecuteSteps} tool_execute, ${turnEndSteps} invoke_turn_end)`,
  );
  console.log(`  totalTokens=${usage?.totalTokens ?? '?'}  cost=$${usage?.cost ?? 0}`);
}

main().catch((err: unknown) => {
  console.error('Recording failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
