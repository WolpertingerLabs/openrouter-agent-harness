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
export async function* aggregateMessages(events, fallbackSessionId) {
    let sessionId;
    let openAssistant = null;
    let openText = null;
    let openThinking = null;
    const flushOpenAssistant = () => {
        const flushed = openAssistant && openAssistant.content.length > 0 ? openAssistant : null;
        openAssistant = null;
        openText = null;
        openThinking = null;
        return flushed;
    };
    const ensureAssistant = () => {
        if (!openAssistant) {
            openAssistant = { type: 'assistant', content: [] };
            openText = null;
            openThinking = null;
        }
        return openAssistant;
    };
    for await (const event of events) {
        switch (event.type) {
            case 'session_started': {
                sessionId = event.sessionId;
                yield { type: 'system', subtype: 'session_start', sessionId };
                break;
            }
            case 'reasoning_delta': {
                const assistant = ensureAssistant();
                if (!openThinking) {
                    openThinking = { type: 'thinking', thinking: '' };
                    assistant.content.push(openThinking);
                }
                openThinking.thinking += event.content;
                // Close any open TextContent so text arriving after this reasoning
                // burst opens a fresh block — content stays in strict event order.
                openText = null;
                break;
            }
            case 'text_delta': {
                const assistant = ensureAssistant();
                if (!openText) {
                    openText = { type: 'text', text: '' };
                    assistant.content.push(openText);
                }
                openText.text += event.content;
                // Close any open ThinkingContent — a later burst of reasoning within
                // the same turn opens a fresh thinking block after this text.
                openThinking = null;
                break;
            }
            case 'tool_call': {
                const assistant = ensureAssistant();
                assistant.content.push({
                    type: 'tool_use',
                    id: event.callId,
                    name: event.name,
                    input: event.input,
                });
                // Force fresh Text/Thinking blocks to be opened if more deltas arrive
                // after this tool call within the same turn (Claude-SDK parity).
                openText = null;
                openThinking = null;
                break;
            }
            case 'tool_result': {
                const flushed = flushOpenAssistant();
                if (flushed)
                    yield flushed;
                const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
                yield {
                    type: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            toolUseId: event.callId,
                            output,
                            isError: event.isError,
                        },
                    ],
                };
                break;
            }
            case 'turn_end': {
                const flushed = flushOpenAssistant();
                if (flushed)
                    yield flushed;
                break;
            }
            case 'stream_complete': {
                const flushed = flushOpenAssistant();
                if (flushed)
                    yield flushed;
                const result = { type: 'result', status: event.status };
                if (event.usage !== undefined)
                    result.usage = event.usage;
                if (event.costUsd !== undefined)
                    result.costUsd = event.costUsd;
                if (event.durationMs !== undefined)
                    result.durationMs = event.durationMs;
                if (event.reason !== undefined)
                    result.reason = event.reason;
                yield result;
                const endSessionId = sessionId ?? fallbackSessionId;
                if (endSessionId !== undefined) {
                    yield { type: 'system', subtype: 'session_end', sessionId: endSessionId };
                }
                break;
            }
            case 'turn_start':
            case 'error':
                // turn_start: turn boundaries are implicit in the message flow.
                // error: subsumed by the trailing stream_complete that carries the
                // message verbatim in `reason`.
                break;
        }
    }
}
//# sourceMappingURL=messages.js.map