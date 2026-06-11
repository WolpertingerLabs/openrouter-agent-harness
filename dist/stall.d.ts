/**
 * Hung-stream detection primitives for the `streamStallTimeoutMs` option
 * (see {@link import('./agent.js').OpenRouterAgentRunOptions.streamStallTimeoutMs}).
 * Pure timer plumbing — no SDK coupling — so the re-arm/suspend semantics can
 * be unit-tested in isolation from {@link OpenRouterAgentRun}. The wiring
 * into the per-cycle drain loop lives in `src/agent.ts`.
 */
/**
 * Error thrown when the SSE event stream produced no events for the
 * configured `streamStallTimeoutMs` while no client tool execution was in
 * flight. Classified as TRANSIENT by the cycle-failure classifier, so the
 * bounded retry/backoff machinery (`maxTransientRetries`) re-issues the
 * stalled cycle automatically. `stallTimeoutMs` carries the threshold that
 * fired so hosts can log/report it without parsing the message.
 */
export declare class StreamStallError extends Error {
    /** The configured stall threshold (ms) that elapsed without stream activity. */
    readonly stallTimeoutMs: number;
    constructor(stallTimeoutMs: number);
}
/**
 * Watchdog over one `callModel` cycle's SSE stream. Tracks the timestamp of
 * the last observed stream event and rejects {@link rejection} with a
 * {@link StreamStallError} once `timeoutMs` elapses with no activity AND the
 * caller-supplied `isSuspended()` gate reports no client tool in flight
 * (tool executions legitimately silence the stream — a 5-minute bash run
 * produces no SSE traffic while it runs).
 *
 * One monitor per cycle ATTEMPT — the transient-retry loop creates a fresh
 * monitor for each re-issued cycle. Always call {@link dispose} in a
 * `finally`: a dangling timer keeps the Node event loop alive and leaks
 * across cycles/tests.
 */
export interface StallMonitor {
    /** Record stream (or tool-completion) activity — resets the stall clock. */
    bump(): void;
    /**
     * Race a pending promise (typically the stream iterator's `next()`)
     * against the stall rejection. When the stall wins, the caller must attach
     * a `.catch(() => undefined)` to the losing promise — its later rejection
     * would otherwise surface as an `unhandledRejection`.
     */
    race<T>(pending: Promise<T>): Promise<T>;
    /** Clear the timer. Idempotent. MUST run in a `finally`. */
    dispose(): void;
}
/**
 * Create a {@link StallMonitor} with a `setTimeout` re-arm chain: when the
 * timer fires, if `isSuspended()` is true the full window is re-armed (the
 * suspension owner bumps activity when it ends); if activity is fresher than
 * `timeoutMs` the timer re-arms for the remainder; otherwise the shared
 * rejection promise rejects with a {@link StreamStallError}.
 *
 * The internal rejection promise gets a no-op `.catch` handle at creation so
 * a stall that fires while nothing is racing (e.g. between `next()` pulls,
 * while the consumer holds the generator at a `yield`) never surfaces as an
 * `unhandledRejection` — the next {@link StallMonitor.race} call still
 * observes the (already settled) rejection immediately.
 */
export declare function createStallMonitor(timeoutMs: number, isSuspended: () => boolean): StallMonitor;
/**
 * Wrap an SSE event stream with a {@link StallMonitor}: each iterator
 * `next()` races against the monitor's stall rejection, and every yielded
 * event bumps the activity clock. When the stall wins the race, the orphaned
 * `next()` promise gets a no-op `.catch` (its later settlement must not
 * become an `unhandledRejection`) and the {@link StreamStallError} propagates
 * to the consumer's catch arm.
 *
 * On early exit (consumer `break`/`throw`, including the stall throw itself)
 * the source iterator's `return()` is fired WITHOUT awaiting it — a genuinely
 * stalled SDK generator is blocked inside an `await` and its `return()`
 * promise would not settle until that await does, which would hang this
 * generator's own unwind. The fire-and-forget close is paired with the
 * caller's `resultHandle.cancel()` teardown of the underlying request.
 */
export declare function monitorStream<T>(source: AsyncIterable<T>, monitor: StallMonitor): AsyncGenerator<T>;
//# sourceMappingURL=stall.d.ts.map