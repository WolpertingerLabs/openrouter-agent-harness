# Integration tests

This directory holds the end-to-end test of `OpenRouterAgentRun` driven against
a deterministic stand-in for `@openrouter/agent`.

## Files

- `mock-openrouter.ts` — the stand-in `OpenRouter` class + type-guard helpers.
  Plays back a recorded JSON `Fixture` step-by-step. **Do not edit** unless the
  grammar genuinely needs to grow — every other piece (recorder, tests) bends
  to fit this file.
- `full-run.test.ts` — the canonical suite. Drives `OpenRouterAgentRun` through
  the mock against the synthetic fixtures below. **Do not edit** as part of a
  fixture refresh — if a recorded fixture would break an assertion, record it
  under a separate `*-recorded.json` name and add a `recorded-fixtures.test.ts`
  case instead.
- `recorded-fixtures.test.ts` — replays live-recorded fixtures (see below)
  through the same mock and asserts shape-only (no exact token-count checks).
- `fixtures/*.json` — replay scripts in the grammar described in
  `mock-openrouter.ts` (`Fixture` / `FixtureStep`).

## Fixture provenance

| Fixture                                                                                                                                                                                                           | Source                                  | Notes                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abort-mid-stream`, `abort-then-throw`, `max-turns`, `single-turn-no-usage`, `tool-call-sdk-omits-ctx-callid`, `single-run-command-echo`, `plan-mode-write-then-read`, `single-tool-call`, `multi-turn-with-tool` | Hand-rolled                             | Exercise specific code branches (abort, denial, omitted ctx, max-turns) that the real SDK either does not produce or that would require lossy assertions to test live. |
| `multi-turn-with-tool-haiku.json`                                                                                                                                                                                 | Recorded — `anthropic/claude-haiku-4.5` | Round-trip proof for the recorder against the same shape as `multi-turn-with-tool`.                                                                                    |
| `single-tool-call-gemini.json`                                                                                                                                                                                    | Recorded — `google/gemini-3.5-flash`    | Cross-provider proof that the recorder produces a replayable fixture for a non-Anthropic model.                                                                        |
| `single-run-command.json`                                                                                                                                                                                         | Recorded — `anthropic/claude-haiku-4.5` | Drives the `permissionMode:'default'` denial test (`full-run.test.ts:372`). 26 steps, 1 `tool_execute`, 1 `invoke_turn_end`, ~749 total tokens, ~$0.00076.             |

## Recording new fixtures

Live recording is a developer tool (`scripts/record-fixture.ts`) — not part of
CI. It runs the real `@openrouter/agent` SDK against the OpenRouter API,
post-processes the event stream into the existing `Fixture` grammar, and writes
a JSON file under `fixtures/`.

### Prerequisites

1. `OPENROUTER_API_KEY` in `.env.local` (gitignored). The harness also accepts
   the variable from the shell environment.
2. `npm install` (the recorder is built on the existing dev deps; no new
   runtime deps are introduced).

### Running

```bash
npm run record:fixture -- \
  --name=<output-fixture-name> \
  --scenario=scripts/scenarios/<scenario>.json \
  [--model=<openrouter-model-id>]
```

- `--name` controls the output filename (`fixtures/<name>.json`).
- `--scenario` points at a small JSON file describing the run.
- `--model` overrides whatever model the scenario declares. Default model
  is `anthropic/claude-haiku-4.5` (same provider family as the library's
  default `~anthropic/claude-sonnet-latest`, cheap enough for casual reruns).

The recorder will:

1. Invoke the real SDK with the scenario's prompt + tool set + instructions.
2. Stream `getFullResponsesStream()` to disk.
3. Drop SDK `tool.call_output` events and synthesize a `tool_execute` step
   right after each `response.output_item.done` whose `item.type` is
   `function_call`. The mock re-executes the tool at replay time and emits
   `tool.call_output` itself.
4. Sanitize the JSON with a replacer that nukes `apiKey` / `Authorization` /
   `authorization` fields and hard-asserts the resulting string does not
   contain any `sk-or-*` substring before writing.

### Scenario format

```json
{
  "prompt": "What the user asks the model. The recorder owns the role/content wrapping.",
  "tools": ["echo"],
  "instructions": "Optional system instructions.",
  "model": "anthropic/claude-haiku-4.5",
  "maxTurns": 3,
  "maxCostUsd": 0.1
}
```

- `prompt` (required) — the user message.
- `tools` (optional, default `[]`) — names from the recorder's tool registry
  in `scripts/record-fixture.ts`. Currently registered: `echo`, `bash`.
  Add more by editing the `TOOL_REGISTRY` constant.
- `instructions` (optional) — system instructions.
- `model` (optional) — overridden by `--model`.
- `maxTurns` (optional, default `5`) — hard cap on the inner loop.
- `maxCostUsd` (optional, default `0.50`) — budget guardrail.

### What to commit

- The recorded **fixture JSON** under `fixtures/` — that's what tests load.
- The **scenario file** under `scripts/scenarios/` — small, human-readable,
  documents the prompt/tool set that produced the fixture.
- The accompanying assertion in `recorded-fixtures.test.ts` — proves the
  recording is shape-compatible with the mock + agent.

Do **not** commit `.env.local`. It is `.gitignore`d.

### Why don't recorded fixtures replace the synthetic ones?

A handful of synthetic fixtures (`abort-mid-stream`, `abort-then-throw`,
`max-turns`, `single-turn-no-usage`, `tool-call-sdk-omits-ctx-callid`) exercise
control-flow branches the real SDK either does not surface (abort
race conditions, omitted `ctx.toolCall.callId`) or that would require lossy
assertions to test live (exact `totalTokens === N`). Those stay hand-rolled.

For the fixtures that _could_ be recorded (`multi-turn-with-tool`,
`single-tool-call`), the existing tests assert exact token counts (`28`, etc.)
that a real recording would never reproduce. Replacing them would force test
loosening, which the project deliberately avoids. Recorded counterparts live
side-by-side (`*-haiku.json`, `*-gemini.json`) and are exercised by
`recorded-fixtures.test.ts` with shape-only assertions.
