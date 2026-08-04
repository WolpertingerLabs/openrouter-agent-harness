/**
 * Type guard: `true` when `value` walks like an `AsyncIterable`. Used by the
 * constructor to discriminate `prompt: string | AsyncIterable<UserInput>`. We
 * detect via the `Symbol.asyncIterator` brand (the language-level contract)
 * rather than instance checks so async generators, hand-rolled iterables, and
 * arbitrary subclasses all pass.
 */
export function isAsyncIterable(value) {
    return (typeof value === 'object' &&
        value !== null &&
        Symbol.asyncIterator in value &&
        typeof value[Symbol.asyncIterator] === 'function');
}
/**
 * Normalize the polymorphic `pushUserMessage` argument (`UserInput | string`)
 * into the canonical struct. `string` becomes `{ content: <string> }`; an
 * already-shaped `UserInput` is returned untouched. The array variant flows
 * through unchanged so image/file content blocks reach `callModel` verbatim.
 */
export function normalizeUserInput(msg) {
    if (typeof msg === 'string')
        return { content: msg };
    return msg;
}
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
export function userInputToCallModelItem(input) {
    return { role: 'user', content: input.content };
}
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
export class StreamingInputSource {
    #queue = [];
    #iter;
    /**
     * For the `prompt: string` overload, the initial string is wrapped into a
     * single `UserInput` and held here so the first `next()` returns it without
     * touching the (absent) iterable. Cleared on first delivery.
     */
    #pendingInitial;
    #iterExhausted = false;
    constructor(prompt) {
        if (typeof prompt === 'string') {
            this.#pendingInitial = { content: prompt };
            this.#iter = undefined;
        }
        else {
            this.#iter = prompt[Symbol.asyncIterator]();
        }
    }
    /**
     * Append `msg` to the imperative queue. Always resolves immediately — the
     * queue is just a buffer with no flow control. Returns a settled Promise so
     * callers can `await` for symmetry with the typed signature even though
     * there is no async work.
     */
    push(msg) {
        this.#queue.push(normalizeUserInput(msg));
    }
    /**
     * Pull the next user input for the streaming-input loop. Resolves with
     * `{ done: true }` exactly when no further input is available (queue empty
     * AND no iterable OR iterable exhausted).
     *
     * Pull order: imperative queue (FIFO) → constructor-supplied iterable.
     * Documented in the class JSDoc.
     */
    async next() {
        if (this.#pendingInitial !== undefined) {
            const v = this.#pendingInitial;
            this.#pendingInitial = undefined;
            return { value: v, done: false };
        }
        const queued = this.#queue.shift();
        if (queued !== undefined)
            return { value: queued, done: false };
        if (this.#iter !== undefined && !this.#iterExhausted) {
            const r = await this.#iter.next();
            if (r.done) {
                this.#iterExhausted = true;
                // Re-check the queue: a push() may have landed while we were awaiting.
                const lateQueued = this.#queue.shift();
                if (lateQueued !== undefined)
                    return { value: lateQueued, done: false };
                return { value: undefined, done: true };
            }
            return { value: r.value, done: false };
        }
        return { value: undefined, done: true };
    }
    /** True when subsequent `next()` calls cannot yield (queue empty, iter exhausted or absent). */
    isExhausted() {
        if (this.#pendingInitial !== undefined)
            return false;
        if (this.#queue.length > 0)
            return false;
        if (this.#iter !== undefined && !this.#iterExhausted)
            return false;
        return true;
    }
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
export async function commitPartialResponse(stateAccessor) {
    const state = await stateAccessor.load();
    if (!state)
        return;
    const partial = state.partialResponse;
    if (!partial?.text) {
        // Even with no text, drop a stale partialResponse so it doesn't linger
        // across runs (e.g. only toolCalls were captured).
        if (partial !== undefined) {
            const next = { ...state, updatedAt: Date.now() };
            delete next.partialResponse;
            await stateAccessor.save(next);
        }
        return;
    }
    const rawMessages = state.messages;
    const existing = Array.isArray(rawMessages) ? rawMessages : [];
    const assistantTurn = {
        type: 'message',
        role: 'assistant',
        content: partial.text,
    };
    const next = {
        ...state,
        messages: [...existing, assistantTurn],
        updatedAt: Date.now(),
    };
    delete next.partialResponse;
    await stateAccessor.save(next);
}
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
export async function setInterruptedFlag(stateAccessor, reason) {
    const state = await stateAccessor.load();
    if (!state) {
        // Skeleton state — only the fields the SDK reads on its first load.
        const now = Date.now();
        const skeleton = {
            id: '',
            messages: [],
            interruptedBy: reason,
            status: 'interrupted',
            createdAt: now,
            updatedAt: now,
        };
        await stateAccessor.save(skeleton);
        return;
    }
    const next = {
        ...state,
        interruptedBy: reason,
        updatedAt: Date.now(),
    };
    await stateAccessor.save(next);
}
//# sourceMappingURL=streaming-input.js.map