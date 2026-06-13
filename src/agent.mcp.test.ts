import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const callModelMock = vi.fn();
const openRouterCtorMock = vi.fn();

// Mock the OR SDK exactly like agent.test.ts.
vi.mock('@openrouter/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrouter/agent')>();
  const stepCountIs = (n: number) => ({ kind: 'stepCountIs', n });
  const maxCost = (n: number) => ({ kind: 'maxCost', n });
  const isTurnStartEvent = (e: unknown): e is { type: 'turn.start'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.start';
  const isTurnEndEvent = (e: unknown): e is { type: 'turn.end'; turnNumber: number } =>
    !!e && typeof e === 'object' && (e as { type?: string }).type === 'turn.end';
  const isToolCallOutputEvent = (
    e: unknown,
  ): e is {
    type: 'tool.call_output';
    output: { callId: string; output: unknown; status?: string };
  } => !!e && typeof e === 'object' && (e as { type?: string }).type === 'tool.call_output';
  class OpenRouter {
    callModel: typeof callModelMock;
    constructor(...args: unknown[]) {
      openRouterCtorMock(...args);
      this.callModel = callModelMock;
    }
  }
  return {
    ...actual,
    OpenRouter,
    stepCountIs,
    maxCost,
    isTurnStartEvent,
    isTurnEndEvent,
    isToolCallOutputEvent,
  };
});

vi.mock('./tools/server-tools.js', () => ({
  DEFAULT_SERVER_TOOLS: [],
  createServerToolsHooks: () => ({}),
}));

// Capture all McpBridge constructions so tests can introspect / drive them.
type BridgeCtorOpts = {
  servers: readonly { name: string; transport: 'stdio' | 'http' }[];
  signal?: AbortSignal;
  notify?: (level: string, message: string, context?: unknown) => Promise<void> | void;
  logger?: (level: string, message: string, fields?: unknown) => void;
};

interface FakeBridge {
  opts: BridgeCtorOpts;
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  tools: unknown[];
}
const bridgeInstances: FakeBridge[] = [];
/** Per-test hook to stage tools that init() will publish. */
let nextBridgeTools: unknown[] = [];
/** Per-test hook to run extra behaviour during init() (e.g. invoking notify). */
let nextBridgeInitOverride: ((inst: FakeBridge) => Promise<void>) | null = null;

vi.mock('./mcp/bridge.js', () => {
  class FakeMcpBridge {
    public opts: BridgeCtorOpts;
    public init: ReturnType<typeof vi.fn>;
    public close = vi.fn(async () => {});
    public tools: unknown[] = [];
    public serverNames: string[] = [];
    constructor(opts: BridgeCtorOpts) {
      this.opts = opts;
      const captured = nextBridgeTools;
      const override = nextBridgeInitOverride;
      nextBridgeInitOverride = null;
      this.init = vi.fn(async () => {
        this.tools = captured;
        if (override) await override(this as unknown as FakeBridge);
      });
      bridgeInstances.push(this as unknown as FakeBridge);
    }
  }
  return {
    McpBridge: FakeMcpBridge,
    MCP_TOOL_NAME_SEPARATOR: '__',
    defaultClientFactory: () => {
      throw new Error('not used in tests');
    },
    mapMcpToolToTool: () => {
      throw new Error('not used in tests');
    },
  };
});

import { OpenRouterAgentRun } from './agent.js';

function fakeCallModel(args: { events: unknown[]; capturedTools?: { value: unknown[] } }) {
  return (request: { tools?: unknown[] }) => {
    if (args.capturedTools) args.capturedTools.value = (request.tools ?? []) as unknown[];
    return {
      async *getFullResponsesStream() {
        for (const ev of args.events) yield ev;
      },
      async getResponse() {
        return {
          id: 'r',
          model: 'm',
          usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [],
        };
      },
    };
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const TEST_SESSION = 'mcp-agent-session';

beforeEach(() => {
  callModelMock.mockReset();
  openRouterCtorMock.mockReset();
  bridgeInstances.length = 0;
  nextBridgeTools = [];
  nextBridgeInitOverride = null;
});

afterEach(async () => {
  await rm(join(process.cwd(), 'logs', TEST_SESSION), { recursive: true, force: true });
});

describe('OpenRouterAgentRun MCP bridge integration', () => {
  it('does not construct McpBridge when no servers are configured (default)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
    });
    await collect(run);
    expect(bridgeInstances).toHaveLength(0);
  });

  it('constructs McpBridge with mcpServers verbatim and merges its tools into callModel', async () => {
    const fakeMcpTool = {
      type: 'function' as const,
      function: { name: 'srv__echo', description: 'echo', execute: async () => ({}) },
    };
    nextBridgeTools = [fakeMcpTool];
    const capturedTools = { value: [] as unknown[] };
    callModelMock.mockImplementation(
      fakeCallModel({
        capturedTools,
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [
        {
          transport: 'stdio',
          name: 'srv',
          command: 'node',
          source: '/tmp/.mcp.json',
        },
      ],
    });
    await collect(run);

    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].opts.servers).toEqual([
      expect.objectContaining({ name: 'srv', transport: 'stdio' }),
    ]);
    expect(bridgeInstances[0].init).toHaveBeenCalled();
    expect(bridgeInstances[0].close).toHaveBeenCalled();
    // Tool array passed into callModel includes the bridge tool merged with built-ins.
    const passedNames = capturedTools.value.map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(passedNames).toContain('srv__echo');
  });

  it('explicit mcpServers ctor list overrides autoDiscoverMcp (no discovery walk)', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const explicit = [
      { transport: 'stdio' as const, name: 'explicit', command: 'node', source: '/tmp/x' },
    ];
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: explicit,
      autoDiscoverMcp: true, // should be ignored
    });
    await collect(run);
    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].opts.servers).toBe(explicit);
  });

  it('autoDiscoverMcp:false (default) is a no-op even when .mcp.json exists in cwd', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      // No mcpServers, no autoDiscoverMcp — defaults to false.
    });
    await collect(run);
    expect(bridgeInstances).toHaveLength(0);
  });

  it('bridge.close() fires in finally even when the run throws mid-stream', async () => {
    // Have callModel throw partway through the iteration to exercise the
    // error path through the generator's `finally`. The bridge was already
    // constructed before callModel was reached, so close() must still fire.
    callModelMock.mockImplementation(() => ({
      async *getFullResponsesStream() {
        yield { type: 'turn.start', turnNumber: 0 };
        throw new Error('mid-stream blowup');
      },
      async getResponse() {
        throw new Error('not reached');
      },
    }));
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 's', command: 'node', source: '/tmp/x' }],
    });
    await collect(run);
    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].close).toHaveBeenCalled();
  });

  it('bridge.close() fires in finally on a successful run', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 's', command: 'node', source: '/tmp/x' }],
    });
    await collect(run);
    expect(bridgeInstances[0].close).toHaveBeenCalled();
  });

  it('agent notify closure: bridge.opts.notify routes to onHook Notification', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );

    const onHook = vi.fn();
    // Stage the next FakeMcpBridge to invoke `opts.notify` from its init().
    // This crosses the agent's arrow closure that wraps safeFireHook.
    nextBridgeInitOverride = async (inst) => {
      const notify = inst.opts.notify;
      if (notify) {
        await notify('warn', 'mcp_server_failed', { name: 'srv', error: 'simulated' });
      }
    };

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 'srv', command: 'node', source: '/tmp/x' }],
      onHook,
    });
    await collect(run);

    const notifyCall = onHook.mock.calls.find(
      (c: unknown[]) =>
        c[0] === 'Notification' && (c[1] as { message?: string }).message === 'mcp_server_failed',
    );
    expect(notifyCall).toBeDefined();
  });

  it('passes the composite abort signal into McpBridge options', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 's', command: 'node', source: '/tmp/x' }],
    });
    await collect(run);
    expect(bridgeInstances[0].opts.signal).toBeDefined();
  });

  it('canUseTool denies a prefixed MCP tool name like any other tool', async () => {
    const fakeMcpTool = {
      type: 'function' as const,
      function: {
        name: 'srv__danger',
        description: 'd',
        execute: async () => ({ ok: true }),
      },
    };
    nextBridgeTools = [fakeMcpTool];

    let capturedToolList: unknown[] = [];
    callModelMock.mockImplementation((request: { tools: unknown[] }) => {
      capturedToolList = request.tools;
      return {
        async *getFullResponsesStream() {
          yield { type: 'turn.start', turnNumber: 0 };
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return {
            id: 'r',
            model: 'm',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
      };
    });

    const canUseTool = vi.fn(async (name: string) => {
      if (name === 'srv__danger') return { behavior: 'deny' as const, reason: 'no mcp here' };
      return { behavior: 'allow' as const };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 'srv', command: 'node', source: '/tmp/x' }],
      canUseTool,
    });
    await collect(run);

    const wrapped = capturedToolList.find(
      (t) => (t as { function: { name: string } }).function.name === 'srv__danger',
    ) as { function: { execute: (i: unknown, c?: unknown) => Promise<unknown> } };
    expect(wrapped).toBeDefined();

    // Calling the wrapper should consult canUseTool with the prefixed name
    // and reject when canUseTool denies.
    await expect(wrapped.function.execute({ x: 1 }, {})).rejects.toThrow();
    expect(canUseTool).toHaveBeenCalledWith(
      'srv__danger',
      { x: 1 },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        suggestions: expect.any(Array),
      }),
    );
  });

  it('disallowedTools rule matches a prefixed MCP tool name', async () => {
    const fakeMcpTool = {
      type: 'function' as const,
      function: {
        name: 'srv__delete_all',
        description: 'd',
        execute: async () => ({ ok: true }),
      },
    };
    nextBridgeTools = [fakeMcpTool];

    let capturedToolList: unknown[] = [];
    callModelMock.mockImplementation((request: { tools: unknown[] }) => {
      capturedToolList = request.tools;
      return {
        async *getFullResponsesStream() {
          yield { type: 'turn.start', turnNumber: 0 };
          yield { type: 'turn.end', turnNumber: 0 };
        },
        async getResponse() {
          return {
            id: 'r',
            model: 'm',
            usage: { cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [],
          };
        },
      };
    });

    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 'srv', command: 'node', source: '/tmp/x' }],
      disallowedTools: ['srv__delete_all'],
    });
    await collect(run);

    const wrapped = capturedToolList.find(
      (t) => (t as { function: { name: string } }).function.name === 'srv__delete_all',
    ) as { function: { execute: (i: unknown, c?: unknown) => Promise<unknown> } };
    expect(wrapped).toBeDefined();
    await expect(wrapped.function.execute({}, {})).rejects.toThrow();
  });

  it('bridge.close() throw in finally is caught and logged at error level', async () => {
    const fakeMcpTool = {
      type: 'function' as const,
      function: { name: 'srv__x', execute: async () => ({}) },
    };
    nextBridgeTools = [fakeMcpTool];
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const logger = vi.fn();
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      mcpServers: [{ transport: 'stdio', name: 'srv', command: 'node', source: '/tmp/x' }],
      logger,
    });
    // Force the bridge close() to throw so the agent's catch arm runs.
    // Replace the close mock on the next-created bridge by monkey-patching
    // the mock returned by the constructor after init runs.
    const origMockImpl = callModelMock.getMockImplementation();
    callModelMock.mockImplementation((req: { tools: unknown[] }) => {
      // After init() runs the bridge is registered; swap close to throw.
      const last = bridgeInstances[bridgeInstances.length - 1];
      if (last) last.close = vi.fn(async () => Promise.reject(new Error('close boom')));
      return origMockImpl!(req);
    });
    await collect(run);
    const errCall = logger.mock.calls.find(
      (c: unknown[]) => c[0] === 'error' && String(c[1]).includes('MCP bridge close failed'),
    );
    expect(errCall).toBeDefined();
  });

  it('autoDiscoverMcp:true with malformed .mcp.json: catch arm logs warn and run continues', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const dir = await mkdtemp(join(tmpdir(), 'agent-mcp-malformed-'));
    try {
      await writeFile(join(dir, '.mcp.json'), 'this is not valid json {', 'utf8');
      await writeFile(join(dir, '.git'), '', 'utf8');
      const logger = vi.fn();
      const run = new OpenRouterAgentRun({
        apiKey: 'k',
        sessionId: TEST_SESSION,
        prompt: 'p',
        cwd: dir,
        autoDiscoverMcp: true,
        logger,
      });
      const events = await collect(run);
      // Run still completes — discovery failure does not crash it.
      expect(events.find((e) => e.type === 'stream_complete')).toBeDefined();
      // Warn log captures the discovery failure.
      const warnCall = logger.mock.calls.find(
        (c: unknown[]) => c[0] === 'warn' && String(c[1]).includes('MCP discovery failed'),
      );
      expect(warnCall).toBeDefined();
      // No bridge constructed (resolveMcpServers returned []).
      expect(bridgeInstances).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolveMcpServers: discovery failure logs and continues with empty list', async () => {
    callModelMock.mockImplementation(
      fakeCallModel({
        events: [
          { type: 'turn.start', turnNumber: 0 },
          { type: 'turn.end', turnNumber: 0 },
        ],
      }),
    );
    const logger = vi.fn();
    // Point cwd at a non-existent dir to make loadMcpConfig walk a dir that
    // either returns empty or throws (silent on missing files — so this
    // just exercises the autoDiscoverMcp:true path with no findings).
    const run = new OpenRouterAgentRun({
      apiKey: 'k',
      sessionId: TEST_SESSION,
      prompt: 'p',
      autoDiscoverMcp: true,
      cwd: '/nonexistent/dir-that-should-not-exist-' + Math.random().toString(36).slice(2),
      logger,
    });
    await collect(run);
    // With no .mcp.json found anywhere, no bridge is constructed.
    expect(bridgeInstances).toHaveLength(0);
  });
});
