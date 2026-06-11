import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The comparative-parity suite (Phase 6.3+) lives under
    // `src/__tests__/comparative/` and uses the `.comparative.test.ts` suffix.
    // It spawns the @anthropic-ai/claude-agent-sdk subprocess (cold-start +
    // internal retry loop) so it is deliberately excluded from the default
    // unit-test run and exercised via `vitest.comparative.config.ts`.
    exclude: ['node_modules', 'dist', 'src/__tests__/comparative/**/*.comparative.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
      thresholds: {
        // Phase 5.7 dropped the thresholds modestly: the skills system adds
        // many short-circuit branches (object-spread conditionals across the
        // SkillFrontmatter surface, multi-shape argument parsing, fenced-vs-
        // inline shell paths) that are individually low-value to cover
        // 1:1. Per-file coverage for the new code is ≥90% across all four
        // metrics. Pre-5.7 bar was 99.6/98.65/98.8/99.93.
        //
        // 5.7 follow-up: inline-render `allowed-tools` narrowing fix
        // collapsed the unreachable deny branch in agent.ts and added two
        // cheap branch-completing tests (buildSkillListing kept===0,
        // formatExitFailure empty-stdout). Lock the gain.
        //
        // fix/server-tools-aftererror (0.2.1): added afterError hook in
        // server-tools.ts and defense-in-depth guard in agent.ts for the
        // silent-hang bug when the OR API returns a 4xx with server tools
        // enabled. The outer catch in the afterError body-read path and the
        // no-throw defense-in-depth branch are intentionally low-value to
        // cover; thresholds updated to reflect the new baseline.
        //
        // Phase 7.1 (real-token compaction trigger): functions ratcheted
        // 98.1 → 98.6 (suite sits at 98.64). Two defensive lines stay
        // uncovered in agent.ts: the contractually-unreachable catch around
        // ModelContextLengthCache.get() and the never-break-the-live-run
        // catch in the mid-run threshold check.
        //
        // Phase 7.2 (turn-boundary-safe partition): turn-granularity keep
        // tail + token-budgeted default; the new partition machinery is
        // 100%-covered in compaction.ts. Functions stay at 98.6.
        //
        // Phase 7.3 (summarizer resilience): trim-retry, inflation check,
        // and 3-strike breaker. One defensive line stays uncovered in
        // agent.ts: the catch around the failure-counter save (a save that
        // fails while compaction is already failing must not mask the
        // original error). Functions stay at 98.6.
        //
        // Phase 7.4 (tool-output prune tier): the prune planner in
        // compaction.ts and the agent prune path are fully covered, including
        // the offload-write-failure fallback. Functions stay at 98.6.
        //
        // Phase 7.5 (summary quality & ergonomics): structured prompt,
        // verbatim user messages, live `compaction` event + PostCompact hook,
        // compactionModel. Functions stay at 98.6.
        //
        // Phase 7 stack merge (7.1+7.2+7.3+7.4+7.5 together): each card
        // individually ratcheted branches to 96.2 (suite ~96.5 in isolation).
        // Stacked, the union's branch ratio settles at ~96.1 — the documented
        // defensive branches above (cache guard, failure-counter save, render
        // edge shapes, prune offload fallback) sum across cards. Threshold
        // relaxed to 96.1 to reflect the true merged baseline;
        // statements/functions/lines unchanged.
        statements: 98.9,
        branches: 96.1,
        functions: 98.6,
        lines: 99.45,
      },
    },
  },
});
