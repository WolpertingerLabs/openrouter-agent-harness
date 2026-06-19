import { describe, it, expectTypeOf } from 'vitest';
import type { AgentCoreEvent, AgentCoreEventStatus, TokenUsage } from './events.js';

describe('AgentCoreEvent union', () => {
  it('discriminates by type', () => {
    type Types = AgentCoreEvent['type'];
    expectTypeOf<Types>().toEqualTypeOf<
      | 'session_started'
      | 'turn_start'
      | 'text_delta'
      | 'reasoning_delta'
      | 'tool_call'
      | 'tool_result'
      | 'server_tool'
      | 'router_decision'
      | 'turn_end'
      | 'stream_complete'
      | 'error'
    >();
  });

  it('narrows variants by discriminant', () => {
    type SessionStarted = Extract<AgentCoreEvent, { type: 'session_started' }>;
    expectTypeOf<SessionStarted>().toEqualTypeOf<{
      type: 'session_started';
      sessionId: string;
      parentSessionId?: string;
    }>();

    type TurnStart = Extract<AgentCoreEvent, { type: 'turn_start' }>;
    expectTypeOf<TurnStart>().toEqualTypeOf<{ type: 'turn_start'; turnNumber: number }>();

    type TextDelta = Extract<AgentCoreEvent, { type: 'text_delta' }>;
    expectTypeOf<TextDelta>().toEqualTypeOf<{ type: 'text_delta'; content: string }>();

    type ToolCall = Extract<AgentCoreEvent, { type: 'tool_call' }>;
    expectTypeOf<ToolCall>().toEqualTypeOf<{
      type: 'tool_call';
      callId: string;
      name: string;
      input: unknown;
    }>();

    type ToolResult = Extract<AgentCoreEvent, { type: 'tool_result' }>;
    expectTypeOf<ToolResult>().toEqualTypeOf<{
      type: 'tool_result';
      callId: string;
      output: unknown;
      isError: boolean;
    }>();

    type TurnEnd = Extract<AgentCoreEvent, { type: 'turn_end' }>;
    expectTypeOf<TurnEnd>().toEqualTypeOf<{
      type: 'turn_end';
      turnNumber: number;
      usage: TokenUsage | null;
      costUsd: number;
    }>();

    type StreamComplete = Extract<AgentCoreEvent, { type: 'stream_complete' }>;
    expectTypeOf<StreamComplete>().toMatchTypeOf<{
      type: 'stream_complete';
      status: AgentCoreEventStatus;
    }>();

    type ErrorEvent = Extract<AgentCoreEvent, { type: 'error' }>;
    expectTypeOf<ErrorEvent>().toMatchTypeOf<{ type: 'error'; message: string }>();

    type RouterDecision = Extract<AgentCoreEvent, { type: 'router_decision' }>;
    expectTypeOf<RouterDecision>().toEqualTypeOf<{
      type: 'router_decision';
      pseudoModel: string;
      resolvedModel: string;
      turn: number;
      phase: 'turn' | 'compaction';
      reason?: string;
      routerName: string;
      fellBack: boolean;
    }>();
  });

  it('AgentCoreEventStatus is the documented closed set', () => {
    expectTypeOf<AgentCoreEventStatus>().toEqualTypeOf<
      'success' | 'max_turns' | 'max_budget' | 'error'
    >();
  });
});
