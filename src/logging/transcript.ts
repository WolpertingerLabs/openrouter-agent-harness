import { appendFile, mkdir, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

/**
 * Schema version for every {@link TranscriptRecord} written. Bumped only when a
 * backward-incompatible field change ships; readers should ignore lines whose
 * `v` they don't understand.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

export interface TranscriptUsage {
  prompt: number;
  completion: number;
  reasoning?: number;
  cached?: number;
}

export interface TranscriptToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export type TranscriptRecord =
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'session_start';
      cwd: string;
      parentSessionId?: string;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'user';
      text: string;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'assistant';
      turnNumber: number;
      requestId: string;
      model: string;
      text?: string;
      reasoning?: string;
      toolCalls?: TranscriptToolCall[];
      usage?: TranscriptUsage;
      costUsd?: number;
      durationMs?: number;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'tool_result';
      callId: string;
      name: string;
      isError: boolean;
      output: unknown;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'server_tool';
      /** Full output-item discriminator, e.g. `"openrouter:web_search"`. */
      toolType: string;
      /** The item's `id` when the provider supplied one. */
      callId?: string;
      /** SDK `ToolCallStatus`: `"completed"` / `"in_progress"` / `"incomplete"`. */
      status: string;
      /** Best-effort model input (e.g. web_search `{ query }`); often absent. */
      input?: unknown;
      /** Result payload with the envelope keys (`type`/`id`/`status`) stripped. */
      output: unknown;
      /** Derived failure flag (web_fetch `error`, or non-`completed` status). */
      isError: boolean;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'compact';
      reason: 'auto' | 'manual';
      droppedMessages: number;
      summaryText: string;
      usage?: TranscriptUsage;
      costUsd?: number;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      /**
       * Phase 7.4: a zero-LLM-call tool-output prune (microcompaction).
       * Older `function_call_output` contents were replaced in place with
       * cleared / stored-at markers; the message + tool-call skeleton is
       * intact.
       */
      kind: 'prune';
      prunedCount: number;
      /** chars/4 estimate of the output bytes reclaimed. */
      reclaimedTokensEstimate: number;
      /** Outputs offloaded to disk (vs cleared) — subset of `prunedCount`. */
      offloadedCount: number;
    }
  | {
      v: typeof TRANSCRIPT_SCHEMA_VERSION;
      sessionId: string;
      ts: string;
      kind: 'session_end';
      status: 'success' | 'max_turns' | 'max_budget' | 'error';
      reason?: string;
      totalUsage?: TranscriptUsage;
      totalCostUsd?: number;
    };

export type TranscriptRecordKind = TranscriptRecord['kind'];

function transcriptPath(logsRoot: string, sessionId: string): string {
  return join(logsRoot, sessionId, 'transcript.jsonl');
}

async function appendRecord(logsRoot: string, record: TranscriptRecord): Promise<void> {
  const path = transcriptPath(logsRoot, record.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

interface CommonInput {
  logsRoot: string;
  sessionId: string;
  ts?: string;
}

function now(input: CommonInput): string {
  return input.ts ?? new Date().toISOString();
}

export async function logTranscriptSessionStart(
  input: CommonInput & {
    cwd: string;
    parentSessionId?: string;
  },
): Promise<void> {
  // `JSON.stringify` drops keys whose value is `undefined`, so we set every
  // optional field unconditionally rather than spreading a per-field guard —
  // the on-disk record stays compact, and the writer has fewer branches.
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'session_start',
    cwd: input.cwd,
    parentSessionId: input.parentSessionId,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptUser(
  input: CommonInput & {
    text: string;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'user',
    text: input.text,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptAssistant(
  input: CommonInput & {
    turnNumber: number;
    requestId: string;
    model: string;
    text?: string;
    reasoning?: string;
    toolCalls?: TranscriptToolCall[];
    usage?: TranscriptUsage;
    costUsd?: number;
    durationMs?: number;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'assistant',
    turnNumber: input.turnNumber,
    requestId: input.requestId,
    model: input.model,
    text: input.text,
    reasoning: input.reasoning,
    toolCalls: input.toolCalls?.length ? input.toolCalls : undefined,
    usage: input.usage,
    costUsd: input.costUsd,
    durationMs: input.durationMs,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptToolResult(
  input: CommonInput & {
    callId: string;
    name: string;
    isError: boolean;
    output: unknown;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'tool_result',
    callId: input.callId,
    name: input.name,
    isError: input.isError,
    output: input.output,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptServerTool(
  input: CommonInput & {
    toolType: string;
    callId?: string;
    status: string;
    input?: unknown;
    output: unknown;
    isError: boolean;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'server_tool',
    toolType: input.toolType,
    // `JSON.stringify` drops undefined-valued keys, so set optionals
    // unconditionally — the on-disk record stays compact (matches the
    // convention in logTranscriptSessionStart / logTranscriptAssistant).
    callId: input.callId,
    status: input.status,
    input: input.input,
    output: input.output,
    isError: input.isError,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptCompact(
  input: CommonInput & {
    reason: 'auto' | 'manual';
    droppedMessages: number;
    summaryText: string;
    usage?: TranscriptUsage;
    costUsd?: number;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'compact',
    reason: input.reason,
    droppedMessages: input.droppedMessages,
    summaryText: input.summaryText,
    usage: input.usage,
    costUsd: input.costUsd,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptPrune(
  input: CommonInput & {
    prunedCount: number;
    reclaimedTokensEstimate: number;
    offloadedCount: number;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'prune',
    prunedCount: input.prunedCount,
    reclaimedTokensEstimate: input.reclaimedTokensEstimate,
    offloadedCount: input.offloadedCount,
  };
  await appendRecord(input.logsRoot, record);
}

export async function logTranscriptSessionEnd(
  input: CommonInput & {
    status: 'success' | 'max_turns' | 'max_budget' | 'error';
    reason?: string;
    totalUsage?: TranscriptUsage;
    totalCostUsd?: number;
  },
): Promise<void> {
  const record: TranscriptRecord = {
    v: TRANSCRIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ts: now(input),
    kind: 'session_end',
    status: input.status,
    reason: input.reason,
    totalUsage: input.totalUsage,
    totalCostUsd: input.totalCostUsd,
  };
  await appendRecord(input.logsRoot, record);
}

/**
 * Stream every record from a session's transcript in append order. Missing
 * file → empty iterable (mirrors the ENOENT-tolerant shape of
 * `createFileStateAccessor.load`). Malformed lines are skipped silently —
 * older readers shouldn't crash on schema-evolution garbage.
 */
export async function* readTranscript(
  logsRoot: string,
  sessionId: string,
): AsyncIterable<TranscriptRecord> {
  const path = transcriptPath(logsRoot, sessionId);
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    const stream = createReadStream(path, { fd: handle.fd, autoClose: false });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as TranscriptRecord;
        yield parsed;
      } catch {
        // skip malformed lines silently
      }
    }
  } finally {
    await handle.close();
  }
}
