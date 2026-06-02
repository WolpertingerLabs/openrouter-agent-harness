# OpenRouter Agent Harness

A CLI-based code editor agent built natively on OpenRouter Agent SDK.

## Goal

Build a code editing agent that runs in the terminal and uses `openrouter/agent` as its native runtime.

## Docs

- [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk/overview)
- [Building Long-Horizon Agents](https://openrouter.ai/docs/cookbook/building-agents/long-horizon-agents)

## Build & Run

```bash
npm install --include=dev
npm run build          # tsc → dist/
npm run dev            # tsx (no compile step)

# Single prompt
node dist/index.js "your prompt here"

# Piped input
echo "your prompt" | node dist/index.js

# Interactive REPL
node dist/index.js
```

Requires `OPENROUTER_API_KEY` env var. See `.env.example` for all options. Optional: `OPENROUTER_BASE_URL` (default: production OpenRouter), `OR_MODEL` (default: `~anthropic/claude-sonnet-latest`), `OR_MAX_STEPS` (default: 25), `OR_MAX_COST` (default: 1.00), `OR_SESSION_ID` (resume a session).

## Architecture

- `src/index.ts` — CLI entry point (REPL + single-prompt + pipe modes)
- `src/agent.ts` — Agent core: `callModel` with tools, streaming, session/state management
- `src/tools/` — Five client tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `run_command`
- `src/tools/server-tools.ts` — OpenRouter server tools: `datetime`, `web_search`, `web_fetch` (injected via SDK hooks)
- `src/logging/logger.ts` — Logs to `logs/[session_id]/[request_id]/[generation_id]/response.json`
- `src/state/file-state.ts` — `StateAccessor` impl using atomic file writes

## Testing

All modules must have unit tests. Run before committing:

```bash
npm test              # vitest run (single pass)
npm run test:watch    # vitest in watch mode
npm run test:coverage # vitest run --coverage (enforces thresholds)
```

Tests live alongside source files as `*.test.ts`. Uses Vitest with ESM. Test files that touch the filesystem use `.test-tmp/` (gitignored, cleaned up in afterEach).

**Requirements:**

- Every new module must have a corresponding `.test.ts` file
- Tests must pass (`npm test`) before code is considered complete
- Tool execute functions must be tested with real filesystem operations (no mocks for I/O)
- Logging and state tests verify actual file output and directory structure
- `npm run build` must succeed (type-check) before `npm test`
- Coverage thresholds are enforced via `npm run test:coverage` — must meet minimums:
  - **Statements: 80%** | **Branches: 70%** | **Functions: 90%** | **Lines: 80%**
- Coverage config lives in `vitest.config.ts`; `src/index.ts` (CLI glue) is excluded from coverage

## Key SDK patterns

- Uses `@openrouter/agent` `callModel()` with `sessionId` for server-side session tracking
- `StateAccessor` persists `ConversationState` (including `previousResponseId`) to disk
- `onTurnEnd` callback logs each intermediate API response
- Zod v4 (`zod/v4`) for tool input schemas — must match SDK's internal zod version
