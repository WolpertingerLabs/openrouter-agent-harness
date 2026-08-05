import type { ConversationState } from '@openrouter/agent';
import type { EasyInputMessage } from '@openrouter/sdk/models';
/**
 * Phase 5.3: a single user-turn payload pushed into an
 * {@link import('./agent.js').OpenRouterAgentRun} via the streaming-input
 * facade (constructor `prompt: AsyncIterable<UserInput>` or
 * `OpenRouterAgentRun.pushUserMessage`).
 *
 * Named `UserInput` (NOT `UserMessage`) because `messages.ts` already exports
 * a `UserMessage` aggregator type (tool-result envelope from the rich message
 * stream). Keeping the names distinct avoids an index.ts re-export collision
 * and reflects the two concepts' different roles — `UserInput` is what the
 * host PUSHES INTO the agent, `UserMessage` (from `messages.ts`) is what the
 * agent EMITS as part of the assistant/user transcript.
 *
 * `content` accepts either a plain string or a lenient `ReadonlyArray<unknown>`
 * of OpenRouter content blocks (text / image / file / audio / video). This
 * harness adds no validation of its own, but the array is NOT forwarded
 * unchecked: the pinned `@openrouter/sdk` validates every block against its
 * own content-block union before the request leaves the process, so an
 * unrecognized block is rejected locally with `Input validation failed`
 * rather than reaching OR. Every block type the README documents passes; a
 * block type newer than the pinned SDK will not. See the README parity
 * matrix's "Streaming input" row for the per-block reference.
 */
export interface UserInput {
    content: string | ReadonlyArray<unknown>;
}
/**
 * Type guard: `true` when `value` walks like an `AsyncIterable`. Used by the
 * constructor to discriminate `prompt: string | AsyncIterable<UserInput>`. We
 * detect via the `Symbol.asyncIterator` brand (the language-level contract)
 * rather than instance checks so async generators, hand-rolled iterables, and
 * arbitrary subclasses all pass.
 */
export declare function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T>;
/**
 * Normalize the polymorphic `pushUserMessage` argument (`UserInput | string`)
 * into the canonical struct. `string` becomes `{ content: <string> }`; an
 * already-shaped `UserInput` is returned untouched. The array variant flows
 * through unchanged so image/file content blocks reach `callModel` verbatim.
 */
export declare function normalizeUserInput(msg: UserInput | string): UserInput;
/**
 * Convert a {@link UserInput} into the `EasyInputMessage` item the OpenRouter
 * Responses API accepts in `callModel({ input })`. Always emits
 * `role: 'user'`; passes `content` through untouched (string-or-array).
 *
 * The single `as` lives here, at the one boundary where the deliberately
 * lenient public `UserInput.content` (`ReadonlyArray<unknown>`) meets the
 * SDK's narrower, mutable content union. Returning the SDK type means the
 * `callModel({ input })` call site needs no cast of its own; the SDK still
 * validates the blocks at request time (see {@link UserInput} JSDoc).
 */
export declare function userInputToCallModelItem(input: UserInput): EasyInputMessage & {
    role: 'user';
};
/**
 * Streaming-input source abstraction. Drains the in-memory `pushUserMessage`
 * queue FIRST (FIFO), then pulls the next value from the constructor-supplied
 * `AsyncIterable<UserInput>` (if any). End-of-input is signaled by `next()`
 * resolving with `{ done: true }`.
 *
 * Semantics:
 *
 * - When the constructor `prompt` is a `string`, the first `next()` yields a
 *   synthetic single-shot `UserInput` carrying that string; subsequent
 *   `next()` calls drain the imperative queue and end when it empties.
 * - When `prompt` is an `AsyncIterable<UserInput>`, the queue is checked
 *   first on each `next()`. If empty, the iterable's `next()` is awaited;
 *   when it returns `{ done: true }` and the queue is still empty on the
 *   next pull, the loop ends.
 * - Calling `push()` while a `next()` is already awaiting the iterable does
 *   NOT preempt the in-flight pull. The pushed value is buffered and
 *   delivered on the FOLLOWING `next()`. This keeps the iterable-driven
 *   contract predictable — the iterable is the primary clock when set.
 * - There is no upper bound on the queue length. Hosts pushing faster than
 *   the agent consumes will see the buffer grow unboundedly (the
 *   `pushUserMessage` API documents this so the host can implement its own
 *   back-pressure if needed).
 */
export declare class StreamingInputSource {
    #private;
    constructor(prompt: string | AsyncIterable<UserInput>);
    /**
     * Append `msg` to the imperative queue. Always resolves immediately — the
     * queue is just a buffer with no flow control. Returns a settled Promise so
     * callers can `await` for symmetry with the typed signature even though
     * there is no async work.
     */
    push(msg: UserInput | string): void;
    /**
     * Pull the next user input for the streaming-input loop. Resolves with
     * `{ done: true }` exactly when no further input is available (queue empty
     * AND no iterable OR iterable exhausted).
     *
     * Pull order: imperative queue (FIFO) → constructor-supplied iterable.
     * Documented in the class JSDoc.
     */
    next(): Promise<{
        value: UserInput;
        done: false;
    } | {
        value: undefined;
        done: true;
    }>;
    /** True when subsequent `next()` calls cannot yield (queue empty, iter exhausted or absent). */
    isExhausted(): boolean;
}
/**
 * Commit any `partialResponse.text` left by a prior interrupt into the
 * persisted message history as an assistant turn, then clear the
 * `partialResponse` field. No-op when there is no saved state, no partial
 * response, or the partial has no text content.
 *
 * Why commit:  When the SDK's `checkForInterruption` fires between turns, it
 * persists the in-flight assistant text under `partialResponse.text` but does
 * NOT append it to `ConversationState.messages`. The next `callModel` would
 * therefore lose that text from the conversation history — the model sees
 * the user push a new turn against a transcript that doesn't include "what I
 * was about to say". Committing the partial as an `assistant` message
 * preserves the Claude-SDK semantic ("partial assistant message committed")
 * and gives the next turn a faithful view of the conversation.
 *
 * What we don't commit:  `partialResponse.toolCalls` — these are tool
 * invocations that were in flight (and whose results never landed) when the
 * interrupt fired. Re-injecting them would leave the model waiting for tool
 * results that will never arrive. The simplest safe path is to drop them;
 * the next user message is appended after the assistant text only.
 */
export declare function commitPartialResponse(stateAccessor: {
    load: () => Promise<ConversationState | null>;
    save: (s: ConversationState) => Promise<void>;
}): Promise<void>;
/**
 * Write `interruptedBy = reason` into the persisted state so the SDK's
 * `checkForInterruption` polling exits the current `callModel` loop cleanly
 * between turns (with `status: 'interrupted'` and `partialResponse` populated).
 *
 * When no state has been persisted yet (load → null), we write a minimal
 * skeleton carrying just the interrupt flag — the SDK's first turn after the
 * call starts will observe the flag and exit immediately. This lets
 * `interrupt()` be called BEFORE iteration begins without throwing.
 *
 * Idempotent: re-writing the flag while it is already set is harmless; the
 * SDK only reads it during its between-turn check.
 */
export declare function setInterruptedFlag(stateAccessor: {
    load: () => Promise<ConversationState | null>;
    save: (s: ConversationState) => Promise<void>;
}, reason: string): Promise<void>;
//# sourceMappingURL=streaming-input.d.ts.map