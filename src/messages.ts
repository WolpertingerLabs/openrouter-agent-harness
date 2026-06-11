import type { AgentCoreEvent, AgentCoreEventStatus, TokenUsage } from './events.js';

/**
 * Plain-text content emitted by the model. Carries the concatenation of every
 * `text_delta` event observed within a single turn — the aggregator buffers
 * deltas into one `TextContent` per {@link AssistantMessage} rather than
 * surfacing them piecemeal.
 */
export type TextContent = { type: 'text'; text: string };

/**
 * Model-issued tool invocation. `id` is the underlying SDK `callId`; `input`
 * mirrors the parsed JSON arguments from the matching `tool_call`
 * {@link import('./events.js').AgentCoreEvent} (falling back to the raw string
 * when the SDK output is unparseable, matching the event-stream's behaviour).
 */
export type ToolUseContent = { type: 'tool_use'; id: string; name: string; input: unknown };

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
 * `text_delta`s and `tool_call`s observed within one turn — the order of the
 * `content` array preserves the order the events were yielded (so a turn that
 * emits text then a tool call appears as `[TextContent, ToolUseContent]`, and
 * a tool-only turn appears as `[ToolUseContent]` with no `TextContent`).
 *
 * Turns that produce neither text nor tool calls yield no `AssistantMessage`
 * (empty messages are suppressed).
 */
export type AssistantMessage = {
  type: 'assistant';
  content: Array<TextContent | ToolUseContent>;
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
export async function* aggregateMessages(
  events: AsyncIterable<AgentCoreEvent>,
  fallbackSessionId?: string,
): AsyncGenerator<AgentMessage> {
  let sessionId: string | undefined;
  let openAssistant: AssistantMessage | null = null;
  let openText: TextContent | null = null;

  const flushOpenAssistant = (): AssistantMessage | null => {
    const flushed = openAssistant && openAssistant.content.length > 0 ? openAssistant : null;
    openAssistant = null;
    openText = null;
    return flushed;
  };
  const ensureAssistant = (): AssistantMessage => {
    if (!openAssistant) {
      openAssistant = { type: 'assistant', content: [] };
      openText = null;
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
      case 'text_delta': {
        const assistant = ensureAssistant();
        if (!openText) {
          openText = { type: 'text', text: '' };
          assistant.content.push(openText);
        }
        openText.text += event.content;
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
        // Force a fresh TextContent to be opened if more text arrives after
        // this tool call within the same turn (Claude-SDK parity).
        openText = null;
        break;
      }
      case 'tool_result': {
        const flushed = flushOpenAssistant();
        if (flushed) yield flushed;
        const output =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
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
      case 'server_tool': {
        // OpenRouter server-executed tools carry both invocation and result in
        // one event. Project them onto the same tool_use → tool_result shape as
        // client tools so the rich message stream renders them uniformly. The
        // correlation id falls back to the toolType when the provider omitted an
        // item id (the pair is still self-consistent within this turn).
        const correlationId = event.callId ?? event.toolType;
        const assistant = ensureAssistant();
        assistant.content.push({
          type: 'tool_use',
          id: correlationId,
          name: event.toolType,
          input: event.input,
        });
        openText = null;
        const flushed = flushOpenAssistant();
        if (flushed) yield flushed;
        const output =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
        yield {
          type: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: correlationId,
              output,
              isError: event.isError,
            },
          ],
        };
        break;
      }
      case 'turn_end': {
        const flushed = flushOpenAssistant();
        if (flushed) yield flushed;
        break;
      }
      case 'stream_complete': {
        const flushed = flushOpenAssistant();
        if (flushed) yield flushed;
        const result: ResultMessage = { type: 'result', status: event.status };
        if (event.usage !== undefined) result.usage = event.usage;
        if (event.costUsd !== undefined) result.costUsd = event.costUsd;
        if (event.durationMs !== undefined) result.durationMs = event.durationMs;
        if (event.reason !== undefined) result.reason = event.reason;
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
