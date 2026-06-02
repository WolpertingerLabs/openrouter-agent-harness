/**
 * Phase 5.2.1 — MCP stdio transport.
 *
 * Thin async wrapper around `@modelcontextprotocol/sdk`'s `Client` +
 * `StdioClientTransport`. The SDK is loaded via dynamic `import()` inside
 * [[McpStdioClient.connect]], so users without MCP servers configured pay
 * zero cold-start cost (and `node_modules/@modelcontextprotocol/sdk` only
 * has to exist on disk if `connect()` is actually called).
 *
 * Not wired into agent runs yet — Card 5.2.4 owns the tool bridge and Card
 * 5.2.5 owns lifecycle hooks. This module is preview-stage public surface.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  ServerCapabilities,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpStdioClientOptions } from './spec.js';

const CLIENT_NAME = 'openrouter-agent-harness';
const CLIENT_VERSION = '0.2.0';

/**
 * Stdio MCP client. Wraps subprocess spawn, JSON-RPC handshake, and the
 * passthrough request methods we need for the tool-bridge work in 5.2.4.
 *
 * Lifecycle:
 *   const client = new McpStdioClient({ command: 'node', args: ['server.mjs'] });
 *   await client.connect();
 *   const { tools } = await client.listTools();
 *   await client.close();
 */
export class McpStdioClient {
  private readonly opts: McpStdioClientOptions;
  private client?: Client;
  private transport?: StdioClientTransport;
  private closed = false;
  private connectStarted = false;
  private lifecycleAbortListener?: () => void;

  constructor(opts: McpStdioClientOptions) {
    this.opts = opts;
  }

  /**
   * Spawns the subprocess, opens the stdio transport, and completes the MCP
   * `initialize` handshake. Idempotent in a narrow sense — calling twice is
   * an error (the SDK's `Client.connect` itself errors if called twice).
   *
   * The optional `signal` cancels this specific handshake call. It composes
   * with the lifecycle signal passed to the constructor — whichever fires
   * first aborts the SDK request.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error('McpStdioClient: cannot connect after close()');
    }
    if (this.connectStarted) {
      throw new Error('McpStdioClient: connect() already called');
    }
    this.connectStarted = true;

    const lifecycle = this.opts.signal;
    if (lifecycle?.aborted) {
      throw abortError(lifecycle.reason);
    }
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    const [{ Client: ClientCtor }, { StdioClientTransport: TransportCtor }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);

    const transport = new TransportCtor({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.env,
      cwd: this.opts.cwd,
      stderr: this.opts.logger ? 'pipe' : 'inherit',
    });

    if (this.opts.logger && transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        this.opts.logger!(
          'debug',
          `[mcp:${this.opts.command}] ${chunk.toString('utf8').trimEnd()}`,
        );
      });
    }

    const client = new ClientCtor({ name: CLIENT_NAME, version: CLIENT_VERSION });
    this.client = client;
    this.transport = transport;

    // Lifecycle-signal listener: extends past `connect()` so a post-handshake
    // abort of the constructor signal also tears the client down. Removed in
    // `close()` (or on handshake failure, below). Per-method signals are
    // composed via `composeSignals` and do NOT trigger this teardown path.
    if (lifecycle) {
      const listener = () => {
        // close() always removes this listener before resetting state, so by
        // construction `this.closed` is false when the listener fires.
        this.closed = true;
        this.client = undefined;
        this.transport = undefined;
        void safeClose(transport);
        const stderr = transport.stderr as { destroy?: () => void } | null | undefined;
        stderr?.destroy?.();
      };
      this.lifecycleAbortListener = listener;
      lifecycle.addEventListener('abort', listener);
    }

    try {
      const composed = composeSignals(lifecycle, signal);
      await client.connect(transport, composed ? { signal: composed } : undefined);
    } catch (err) {
      if (lifecycle && this.lifecycleAbortListener) {
        lifecycle.removeEventListener('abort', this.lifecycleAbortListener);
        this.lifecycleAbortListener = undefined;
      }
      await safeClose(transport);
      this.client = undefined;
      this.transport = undefined;
      throw err;
    }
  }

  /** Idempotent — calling on an already-closed client is a no-op. */
  async close(): Promise<void> {
    // Always detach the lifecycle listener if present, even on a re-close, so
    // we don't leak a reference back to the caller's AbortSignal.
    if (this.opts.signal && this.lifecycleAbortListener) {
      this.opts.signal.removeEventListener('abort', this.lifecycleAbortListener);
      this.lifecycleAbortListener = undefined;
    }
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (client) {
      await safeClose(client);
    }
    // The SDK's PassThrough stderr stream can outlive the subprocess and
    // hold a file handle open. Destroy it explicitly so vitest's
    // hanging-process detector doesn't flag it.
    const stderr = transport?.stderr as { destroy?: () => void } | null | undefined;
    stderr?.destroy?.();
  }

  /** Server capabilities advertised during `initialize`. `undefined` before connect. */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  /** Server name+version pair from `initialize`. `undefined` before connect. */
  getServerVersion(): Implementation | undefined {
    return this.client?.getServerVersion();
  }

  async listTools(signal?: AbortSignal): Promise<ListToolsResult> {
    return this.requireClient().listTools(undefined, this.requestOptions(signal));
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return (await this.requireClient().callTool(
      { name, arguments: args },
      undefined,
      this.requestOptions(signal),
    )) as CallToolResult;
  }

  async listResources(signal?: AbortSignal): Promise<ListResourcesResult> {
    return this.requireClient().listResources(undefined, this.requestOptions(signal));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return this.requireClient().readResource({ uri }, this.requestOptions(signal));
  }

  async listPrompts(signal?: AbortSignal): Promise<ListPromptsResult> {
    return this.requireClient().listPrompts(undefined, this.requestOptions(signal));
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    return this.requireClient().getPrompt({ name, arguments: args }, this.requestOptions(signal));
  }

  private requestOptions(perCall?: AbortSignal): { signal: AbortSignal } | undefined {
    const composed = composeSignals(this.opts.signal, perCall);
    return composed ? { signal: composed } : undefined;
  }

  private requireClient(): Client {
    if (!this.client || this.closed) {
      throw new Error('McpStdioClient: not connected (call connect() first)');
    }
    return this.client;
  }
}

function composeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'The operation was aborted',
    'AbortError',
  );
}

async function safeClose(closable: { close(): Promise<void> }): Promise<void> {
  try {
    await closable.close();
  } catch {
    /* swallow — close is best-effort on the teardown paths */
  }
}
