/**
 * Phase 5.2.2 — MCP HTTP + SSE transport.
 *
 * Thin async wrapper around `@modelcontextprotocol/sdk`'s `Client` driven by
 * either `StreamableHTTPClientTransport` (modern, preferred) or
 * `SSEClientTransport` (deprecated, kept for back-compat). The transport is
 * chosen by the `transport: 'streamableHttp' | 'sse'` discriminator on the
 * constructor options.
 *
 * The SDK is loaded via dynamic `import()` inside [[McpHttpClient.connect]],
 * so users without MCP servers configured pay zero cold-start cost (and
 * `node_modules/@modelcontextprotocol/sdk` only has to exist on disk if
 * `connect()` is actually called).
 *
 * The public surface (`connect`/`close`/`listTools`/`callTool`/
 * `listResources`/`readResource`/`listPrompts`/`getPrompt`) mirrors
 * [[McpStdioClient]] in `transport-stdio.ts` exactly — Card 5.2.4's
 * tool-bridge consumes the two interchangeably via a structural type.
 *
 * Not wired into agent runs yet — Card 5.2.4 owns the tool bridge and Card
 * 5.2.5 owns lifecycle hooks. This module is preview-stage public surface.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

import type { McpHttpClientOptions } from './spec.js';

const CLIENT_NAME = 'openrouter-agent-harness';
const CLIENT_VERSION = '0.2.0';

type SdkTransport = StreamableHTTPClientTransport | SSEClientTransport;

/**
 * HTTP MCP client. Wraps the chosen transport, the JSON-RPC handshake, and the
 * passthrough request methods we need for the tool-bridge work in 5.2.4.
 *
 * Lifecycle:
 *   const client = new McpHttpClient({
 *     transport: 'streamableHttp',
 *     url: 'https://example.com/mcp',
 *   });
 *   await client.connect();
 *   const { tools } = await client.listTools();
 *   await client.close();
 */
export class McpHttpClient {
  private readonly opts: McpHttpClientOptions;
  private client?: Client;
  private transport?: SdkTransport;
  private closed = false;
  private connectStarted = false;
  private lifecycleAbortListener?: () => void;

  constructor(opts: McpHttpClientOptions) {
    this.opts = opts;
  }

  /**
   * Opens the chosen HTTP transport and completes the MCP `initialize`
   * handshake. Idempotent in a narrow sense — calling twice is an error.
   *
   * The optional `signal` cancels this specific handshake call. It composes
   * with the lifecycle signal passed to the constructor — whichever fires
   * first aborts the SDK request; only the lifecycle signal closes the
   * transport.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error('McpHttpClient: cannot connect after close()');
    }
    if (this.connectStarted) {
      throw new Error('McpHttpClient: connect() already called');
    }
    this.connectStarted = true;

    const lifecycle = this.opts.signal;
    if (lifecycle?.aborted) {
      throw abortError(lifecycle.reason);
    }
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    let url: URL;
    try {
      url = new URL(this.opts.url);
    } catch (err) {
      throw new Error(
        `McpHttpClient: invalid url ${JSON.stringify(this.opts.url)} — ${(err as Error).message}`,
        { cause: err },
      );
    }

    const [{ Client: ClientCtor }, transport] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      this.buildTransport(url),
    ]);

    const logger = this.opts.logger;
    if (logger) {
      transport.onerror = (err: Error) => {
        logger('warn', `[mcp:${this.opts.transport}] transport error: ${err.message}`, {
          url: url.href,
        });
      };
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
      };
      this.lifecycleAbortListener = listener;
      lifecycle.addEventListener('abort', listener);
    }

    try {
      const composed = composeSignals(lifecycle, signal);
      // The deprecated SSE transport's `start()` waits for an `endpoint` SSE
      // event and does NOT honor the SDK's `RequestOptions.signal` during
      // that wait (the signal only gates the subsequent `initialize` POST).
      // Race the connect against the composed signal so a mid-handshake abort
      // rejects the promise regardless of which transport we picked.
      // composed is not pre-aborted here — `lifecycle?.aborted` and
      // `signal?.aborted` were both checked at the top of `connect()`.
      await (composed
        ? Promise.race([
            client.connect(transport, { signal: composed }),
            new Promise<never>((_, reject) => {
              composed.addEventListener('abort', () => reject(abortError(composed.reason)), {
                once: true,
              });
            }),
          ])
        : client.connect(transport));
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
    this.client = undefined;
    this.transport = undefined;
    if (client) {
      await safeClose(client);
    }
  }

  /** Server capabilities advertised during `initialize`. `undefined` before connect. */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  /** Server name+version pair from `initialize`. `undefined` before connect. */
  getServerVersion(): Implementation | undefined {
    return this.client?.getServerVersion();
  }

  /**
   * Streamable HTTP session ID (server-issued via `Mcp-Session-Id`). Always
   * `undefined` on the deprecated SSE transport and before `connect()`.
   */
  getSessionId(): string | undefined {
    const t = this.transport as StreamableHTTPClientTransport | undefined;
    return t && 'sessionId' in t ? t.sessionId : undefined;
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

  private async buildTransport(url: URL): Promise<SdkTransport> {
    if (this.opts.transport === 'streamableHttp') {
      const { StreamableHTTPClientTransport: Ctor } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const requestInit: RequestInit | undefined = this.opts.headers
        ? { headers: this.opts.headers }
        : undefined;
      return new Ctor(url, {
        ...(requestInit ? { requestInit } : {}),
        ...(this.opts.reconnection
          ? {
              reconnectionOptions: {
                // Fill any missing keys with SDK defaults so the public type
                // can keep all four fields optional.
                maxReconnectionDelay: this.opts.reconnection.maxReconnectionDelay ?? 30_000,
                initialReconnectionDelay: this.opts.reconnection.initialReconnectionDelay ?? 1_000,
                reconnectionDelayGrowFactor:
                  this.opts.reconnection.reconnectionDelayGrowFactor ?? 1.5,
                maxRetries: this.opts.reconnection.maxRetries ?? 2,
              },
            }
          : {}),
      });
    }
    const { SSEClientTransport: Ctor } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const requestInit: RequestInit | undefined = this.opts.headers
      ? { headers: this.opts.headers }
      : undefined;
    return new Ctor(url, requestInit ? { requestInit } : undefined);
  }

  private requestOptions(perCall?: AbortSignal): { signal: AbortSignal } | undefined {
    const composed = composeSignals(this.opts.signal, perCall);
    return composed ? { signal: composed } : undefined;
  }

  private requireClient(): Client {
    if (!this.client || this.closed) {
      throw new Error('McpHttpClient: not connected (call connect() first)');
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
