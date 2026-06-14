// Routers / pseudomodels end-to-end scenario (Step 11).
//
// The router/pseudomodel feature is OpenRouter-only — the Claude Agent SDK has
// no analogue — so this scenario does NOT use the dual-SDK `runScenario`
// comparator (which asserts parity between BOTH SDKs). Instead it drives
// `OpenRouterAgentRun` against a minimal in-process `/responses` provider that
// records the `model` field of every request body it receives. That gives a
// DIRECT end-to-end assertion: the model the router resolved is the model the
// emulated provider actually saw on the wire — not the pseudomodel the run was
// constructed with, and not a value inferred from a hash match.
//
// We reuse the comparative emulator's OpenResponses event builder
// (`buildOpenResponsesEvents` + `SSE_RESPONSES_DONE`) so the wire bytes the OR
// SDK consumes are identical to the canonical-scenario suite's — the only
// thing this server adds over `startEmulator` is request-body capture, which
// the script-registry-based emulator deliberately doesn't expose.
//
// Three claims:
//   1. A pseudomodel resolves to its concrete model end-to-end (single turn).
//   2. A sticky (default) decision stays pinned across a multi-turn run — the
//      provider sees the SAME concrete model on every turn.
//   3. A `sticky: false` decision re-decides every turn — the provider sees a
//      DIFFERENT concrete model per turn.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, afterEach } from 'vitest';

import { OpenRouterAgentRun } from '../../agent.js';
import type { AgentCoreEvent } from '../../events.js';
import type { RouterPlugin, RouteDecision } from '../../router.js';
import type { UserInput } from '../../streaming-input.js';

import {
  buildOpenResponsesEvents,
  SSE_RESPONSES_DONE,
  type OpenResponsesResponse,
} from './emulator/index.js';

// ----- Minimal request-capturing /responses provider -----
//
// One serialized SSE event in the OpenResponses vocabulary. The emulator's
// internal `serializeSseEvent` is not exported, so we inline the (trivial)
// data-only framing the OR client's EventStream parser consumes.
function serializeSseEvent(ev: { event: string; data: unknown }): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

type CapturingProvider = {
  readonly url: string;
  /** The `model` field of every `/responses` request body, in arrival order. */
  readonly seenModels: string[];
  stop(): Promise<void>;
};

async function startCapturingProvider(): Promise<CapturingProvider> {
  const seenModels: string[] = [];
  let responseCounter = 0;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'unexpected route' } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      model?: string;
    };
    seenModels.push(String(body.model));

    // Plain assistant text, terminal status — no tool calls — so the agent
    // ends the turn and (for a multi-input prompt) pulls the next input.
    const response: OpenResponsesResponse = {
      id: `resp_${responseCounter++}`,
      model: String(body.model),
      status: 'completed',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const events = buildOpenResponsesEvents(response);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const ev of events) res.write(serializeSseEvent(ev));
    res.write(SSE_RESPONSES_DONE);
    res.end();
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    seenModels,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ----- Run drivers -----

/** A two-input streaming prompt so the run drives two callModel cycles. */
function twoTurnPrompt(): AsyncGenerator<UserInput> {
  return (async function* () {
    yield { content: 'one' };
    yield { content: 'two' };
  })();
}

/** Drain a run, collecting every yielded event. */
async function collect(run: OpenRouterAgentRun): Promise<AgentCoreEvent[]> {
  const events: AgentCoreEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

function routerDecisions(
  events: AgentCoreEvent[],
): Array<Extract<AgentCoreEvent, { type: 'router_decision' }>> {
  return events.filter(
    (e): e is Extract<AgentCoreEvent, { type: 'router_decision' }> => e.type === 'router_decision',
  );
}

describe('comparative scenario: routers / pseudomodels (OR-only end-to-end)', () => {
  let provider: CapturingProvider | undefined;

  afterEach(async () => {
    if (provider) await provider.stop();
    provider = undefined;
  });

  it('resolves a pseudomodel to its concrete model on the wire (single turn)', async () => {
    provider = await startCapturingProvider();
    const router: RouterPlugin = {
      name: 'coding-router',
      provides: ['auto/coding'],
      route: (): RouteDecision => ({ model: 'real/concrete', reason: 'because coding' }),
    };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-or-emulator-stub',
      sessionId: 'routers-single',
      prompt: 'hi',
      model: 'auto/coding',
      baseUrl: provider.url,
      persistSession: false,
      routers: [router],
    });
    const decisions = routerDecisions(await collect(run));

    // The provider saw the RESOLVED model, never the pseudomodel.
    expect(provider.seenModels).toEqual(['real/concrete']);
    expect(provider.seenModels).not.toContain('auto/coding');
    // And the decision the run emitted agrees with what reached the wire.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      pseudoModel: 'auto/coding',
      resolvedModel: 'real/concrete',
      routerName: 'coding-router',
      fellBack: false,
    });
  });

  it('keeps a sticky (default) decision pinned across a multi-turn run', async () => {
    provider = await startCapturingProvider();
    let n = 0;
    const route = (): RouteDecision => ({ model: `concrete/${n++}` });
    const router: RouterPlugin = { name: 'sticky-router', provides: ['auto/sticky'], route };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-or-emulator-stub',
      sessionId: 'routers-sticky',
      prompt: twoTurnPrompt(),
      model: 'auto/sticky',
      baseUrl: provider.url,
      persistSession: false,
      routers: [router],
    });
    const decisions = routerDecisions(await collect(run));

    // Two turns hit the provider, both with the first (cached) decision.
    expect(provider.seenModels).toEqual(['concrete/0', 'concrete/0']);
    // The router was consulted once; the decision event fired once.
    expect(n).toBe(1);
    expect(decisions.map((d) => d.resolvedModel)).toEqual(['concrete/0']);
  });

  it('re-decides every turn when sticky is false', async () => {
    provider = await startCapturingProvider();
    let n = 0;
    const route = (): RouteDecision => ({ model: `concrete/${n++}`, sticky: false });
    const router: RouterPlugin = { name: 'fresh-router', provides: ['auto/fresh'], route };
    const run = new OpenRouterAgentRun({
      apiKey: 'sk-or-emulator-stub',
      sessionId: 'routers-fresh',
      prompt: twoTurnPrompt(),
      model: 'auto/fresh',
      baseUrl: provider.url,
      persistSession: false,
      routers: [router],
    });
    const decisions = routerDecisions(await collect(run));

    // Each turn re-decided, so the provider saw a distinct concrete model.
    expect(provider.seenModels).toEqual(['concrete/0', 'concrete/1']);
    expect(n).toBe(2);
    expect(decisions.map((d) => [d.turn, d.resolvedModel])).toEqual([
      [0, 'concrete/0'],
      [1, 'concrete/1'],
    ]);
  });
});
