import type { AgentCoreEvent, AgentCoreEventStatus, TokenUsage } from './events.js';
/**
 * Plain-text content emitted by the model. Carries the concatenation of every
 * `text_delta` event observed within a single turn — the aggregator buffers
 * deltas into one `TextContent` per {@link AssistantMessage} rather than
 * surfacing them piecemeal.
 */
export type TextContent = {
    type: 'text';
    text: string;
};
/**
 * Reasoning/thinking text emitted by a reasoning model. Carries the
 * concatenation of every contiguous `reasoning_delta` event observed within a
 * single turn — mirroring the Claude SDK's `thinking` content block shape
 * (`{ type: 'thinking', thinking: string }`) so consumers porting message
 * handlers between SDKs can reuse their narrowing. Reasoning deltas arrive on
 * the wire BEFORE the turn's visible text, so a thinking block always
 * precedes the {@link TextContent} it led to within the same
 * {@link AssistantMessage} (matching how a transcript renders reasoning →
 * tool_use → text). Plaintext reasoning only — encrypted reasoning items
 * produce no deltas, hence no thinking block.
 */
export type ThinkingContent = {
    type: 'thinking';
    thinking: string;
};
/**
 * Model-issued tool invocation. `id` is the underlying SDK `callId`; `input`
 * mirrors the parsed JSON arguments from the matching `tool_call`
 * {@link import('./events.js').AgentCoreEvent} (falling back to the raw string
 * when the SDK output is unparseable, matching the event-stream's behaviour).
 */
export type ToolUseContent = {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
};
/**
 * Tool execution result reported back to the model. `toolUseId` correlates 1:1
 * with the {@link ToolUseContent} `id` it answers. `output` is stringified
 * (always a string) so consumers don't have to discriminate on a `unknown`
 * payload; `isError` mirrors the underlying `tool_result.isError`.
 */
export type ToolResultContent = {
    type: 'tool_result';
    toolUseId: string;
    output: string;
    isError: boolean;
};
/**
 * Lifecycle bookend messages. `session_start` is the first message yielded by
 * {@link import('./agent.js').OpenRouterAgentRun.messages}; `session_end` is
 * the last. Both carry the run's `sessionId` for cross-reference.
 */
export type SystemMessage = {
    type: 'system';
    subtype: 'session_start' | 'session_end';
    sessionId: string;
};
/**
 * Aggregated per-turn assistant message. A single message buffers ALL
 * `reasoning_delta`s, `text_delta`s, and `tool_call`s observed within one
 * turn — the order of the `content` array preserves the order the events
 * were yielded (so a turn that thinks, then emits text, then a tool call
 * appears as `[ThinkingContent, TextContent, ToolUseContent]`; a tool-only
 * turn appears as `[ToolUseContent]` with neither text nor thinking).
 * Because reasoning streams before visible output, thinking blocks naturally
 * precede the text/tool blocks they led to.
 *
 * Turns that produce no thinking, text, or tool calls yield no
 * `AssistantMessage` (empty messages are suppressed).
 */
export type AssistantMessage = {
    type: 'assistant';
    content: Array<ThinkingContent | TextContent | ToolUseContent>;
};
/**
 * Aggregated tool-result message. Each `tool_result` event yields one
 * `UserMessage` carrying exactly one {@link ToolResultContent}. Emitting a
 * `UserMessage` always flushes any open {@link AssistantMessage} first so the
 * ordering on the wire is "model speaks → tool answers" within a turn.
 */
export type UserMessage = {
    type: 'user';
    content: Array<ToolResultContent>;
};
/**
 * Final result envelope. Carries the same fields as the underlying
 * `stream_complete` {@link import('./events.js').AgentCoreEvent}. Always
 * followed by a `SystemMessage{subtype:'session_end'}` so the message stream
 * has a single, well-defined terminator after `ResultMessage`.
 */
export type ResultMessage = {
    type: 'result';
    status: AgentCoreEventStatus;
    usage?: TokenUsage | null;
    costUsd?: number;
    durationMs?: number;
    reason?: string;
};
/**
 * Discriminated union over the four message kinds. `type` is the
 * discriminator. The aggregator guarantees the per-run ordering:
 * `SystemMessage(session_start)` → (`AssistantMessage` | `UserMessage`)* →
 * `ResultMessage` → `SystemMessage(session_end)`. The interior is empty when
 * the run is aborted at construction time (no events to aggregate).
 */
export type AgentMessage = SystemMessage | AssistantMessage | UserMessage | ResultMessage;
/**
 * Drain an {@link AgentCoreEvent} stream and yield aggregated
 * {@link AgentMessage}s. Stateless across calls — one generator per run.
 *
 * Aggregation rules:
 * - `session_started` → emit `SystemMessage{session_start}`.
 * - `reasoning_delta` → buffer into the current {@link AssistantMessage}'s
 *   open {@link ThinkingContent} (concatenated). A `text_delta` or
 *   `tool_call` closes the open thinking block, so a later burst of
 *   reasoning opens a fresh one — content blocks stay in event order, and
 *   since reasoning streams before visible output, thinking precedes the
 *   text/tool blocks it led to (Claude-SDK thinking-block parity).
 * - `text_delta` → buffer into the current {@link AssistantMessage}'s open
 *   {@link TextContent} (concatenated). If a `tool_use` was the last content
 *   pushed, a fresh `TextContent` is opened — the assistant message ends up
 *   with interleaved `[Text, ToolUse, Text]` content blocks in event order.
 *   This matches the Claude SDK's "one assistant message per turn" behaviour
 *   where text and tool blocks can interleave inside a single message.
 * - `tool_call` → append a {@link ToolUseContent} to the current
 *   `AssistantMessage`'s content (closing any open `TextContent`). A
 *   `tool_call` with no prior `text_delta` opens the `AssistantMessage` with
 *   `content: [ToolUseContent]` (no text block).
 * - `tool_result` → flush the open `AssistantMessage` (if any), then emit a
 *   {@link UserMessage} carrying one {@link ToolResultContent}.
 * - `turn_end` → flush the open `AssistantMessage`. Per-turn state resets.
 * - `stream_complete` → flush, emit {@link ResultMessage}, then emit
 *   `SystemMessage{session_end}`.
 *
 * Empty turns (turn_end with no buffered text/tool content) yield nothing.
 * Abort mid-stream follows the same flush rules — any open AssistantMessage is
 * flushed before the terminal ResultMessage so no buffered content is lost.
 *
 * `turn_start` and `error` events have no message-level mapping: turn
 * boundaries are implicit in the assistant/user flow, and `error` is always
 * followed by a `stream_complete` whose `reason` carries the message.
 *
 * `fallbackSessionId` is used for the trailing `SystemMessage{session_end}`
 * when the underlying stream never emitted a `session_started` event (e.g.
 * the run was aborted at construction time). When neither is available the
 * `session_end` bookend is suppressed.
 */
export declare function aggregateMessages(events: AsyncIterable<AgentCoreEvent>, fallbackSessionId?: string): AsyncGenerator<AgentMessage>;
//# sourceMappingURL=messages.d.ts.map