/**
 * Smoke coverage for the @inite/brain-mcp connector bridge (v0.2.0) —
 * the wiring in clients/brain-mcp/src/bridge.ts, exercised against a
 * REAL MCP client over an in-memory transport (the SDK's linked-pair
 * test idiom), with the upstream brain stubbed:
 *
 *  - capability mirror: tools always, resources only when the upstream
 *    advertises them (a bridge must never promise what brain can't serve);
 *  - tools/list + tools/call forward params verbatim;
 *  - resources/templates/list + resources/read passthrough — the surface
 *    that made brain://entity/... visible through the bridge;
 *  - a tools-only upstream registers NO resource handlers (the harness
 *    gets the standard capability error, not a hang);
 *  - sampling reverse-passthrough: brain's sampling/createMessage is
 *    forwarded to the downstream harness when it advertises sampling,
 *    and fails with a clean McpError when it doesn't (brain's sampling
 *    path catches errors and falls back to its local template).
 *
 * The bridge package has no test toolchain of its own; its source is
 * plain SDK wiring with no relative imports, so the repo suite smokes it
 * directly against the repo's SDK install.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createBridgeServer,
  downstreamCapabilities,
  registerSamplingPassthrough,
} from '../clients/brain-mcp/src/bridge';

type SamplingHandler = (request: {
  method: 'sampling/createMessage';
  params: Record<string, unknown>;
}) => Promise<unknown>;

function stubUpstream() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, arg: unknown) => (calls[name] ??= []).push(arg);
  let samplingHandler: SamplingHandler | undefined;
  const upstream = {
    listTools: async (params?: unknown) => {
      record('listTools', params);
      return {
        tools: [
          {
            name: 'search_knowledge',
            description: 'stub',
            inputSchema: { type: 'object' as const },
          },
        ],
      };
    },
    callTool: async (params: unknown) => {
      record('callTool', params);
      return { content: [{ type: 'text' as const, text: 'called' }] };
    },
    listResources: async (params?: unknown) => {
      record('listResources', params);
      return { resources: [] };
    },
    listResourceTemplates: async (params?: unknown) => {
      record('listResourceTemplates', params);
      return {
        resourceTemplates: [
          { uriTemplate: 'brain://entity/{entityId}', name: 'entity-profile' },
          { uriTemplate: 'brain://entity/{entityId}/timeline', name: 'entity-timeline' },
        ],
      };
    },
    readResource: async (params: { uri: string }) => {
      record('readResource', params);
      return {
        contents: [{ uri: params.uri, mimeType: 'application/json', text: '{"stub":true}' }],
      };
    },
    setRequestHandler: (_schema: unknown, handler: SamplingHandler) => {
      samplingHandler = handler;
    },
  };
  return { upstream, calls, getSamplingHandler: () => samplingHandler };
}

async function connectHarness(
  server: Server,
  capabilities: Record<string, unknown> = {},
): Promise<Client> {
  const client = new Client({ name: 'harness', version: '1.0.0' }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('brain-mcp bridge — capability mirror', () => {
  it('mirrors tools always and resources only when the upstream has them', () => {
    expect(downstreamCapabilities({ tools: { listChanged: true } })).toEqual({
      tools: { listChanged: true },
    });
    expect(downstreamCapabilities({ tools: {}, resources: { subscribe: false } })).toEqual({
      tools: {},
      resources: { subscribe: false },
    });
    // No tools advertised upstream (never the case for brain, but the
    // mirror must not invent undefined) → empty tools object, no resources.
    expect(downstreamCapabilities({})).toEqual({ tools: {} });
  });
});

describe('brain-mcp bridge — passthrough over a real MCP wire', () => {
  it('forwards tools/list, tools/call, resources/templates/list, resources/read verbatim', async () => {
    const { upstream, calls } = stubUpstream();
    const server = createBridgeServer({
      upstream: upstream as never,
      upstreamCapabilities: { tools: {}, resources: {} },
      name: 'brain',
      version: '9.9.9',
    });
    const client = await connectHarness(server);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(['search_knowledge']);

      const result = await client.callTool({
        name: 'search_knowledge',
        arguments: { query: 'acme' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'called' }]);
      // Params reach the upstream verbatim — no curation, no renaming.
      expect(calls['callTool']![0]).toMatchObject({
        name: 'search_knowledge',
        arguments: { query: 'acme' },
      });

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
        'brain://entity/{entityId}',
        'brain://entity/{entityId}/timeline',
      ]);

      const read = await client.readResource({ uri: 'brain://entity/e1' });
      expect(read.contents[0]).toMatchObject({ uri: 'brain://entity/e1' });
      expect(calls['readResource']![0]).toMatchObject({ uri: 'brain://entity/e1' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a tools-only upstream registers no resource surface downstream', async () => {
    const { upstream } = stubUpstream();
    const server = createBridgeServer({
      upstream: upstream as never,
      upstreamCapabilities: { tools: {} },
      name: 'brain',
      version: '9.9.9',
    });
    const client = await connectHarness(server);
    try {
      // No handler registered → the bridge answers with the protocol's
      // standard method-not-found error (never a hang, never a forward
      // to an upstream that would reject it anyway).
      await expect(client.listResources()).rejects.toThrow(/Method not found|resources/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('brain-mcp bridge — sampling reverse-passthrough', () => {
  it('forwards sampling/createMessage to a harness that advertises sampling', async () => {
    const { upstream, getSamplingHandler } = stubUpstream();
    const server = createBridgeServer({
      upstream: upstream as never,
      upstreamCapabilities: { tools: {} },
      name: 'brain',
      version: '9.9.9',
    });
    registerSamplingPassthrough({ upstream: upstream as never, server });
    const handler = getSamplingHandler();
    expect(handler).toBeDefined();

    const client = new Client(
      { name: 'harness', version: '1.0.0' },
      { capabilities: { sampling: {} } },
    );
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      model: 'harness-model',
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'one-line briefing from the harness LLM' },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const out = (await handler!({
        method: 'sampling/createMessage',
        params: {
          messages: [{ role: 'user', content: { type: 'text', text: 'summarize acme' } }],
          maxTokens: 32,
        },
      })) as { model: string; content: { text: string } };
      expect(out.model).toBe('harness-model');
      expect(out.content.text).toContain('briefing');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails with a clean McpError when the harness lacks sampling (brain then falls back)', async () => {
    const { upstream, getSamplingHandler } = stubUpstream();
    const server = createBridgeServer({
      upstream: upstream as never,
      upstreamCapabilities: { tools: {} },
      name: 'brain',
      version: '9.9.9',
    });
    registerSamplingPassthrough({ upstream: upstream as never, server });
    const client = await connectHarness(server); // no sampling capability
    try {
      // Assert on the error's wire shape, not instanceof: when the shim
      // package has its own node_modules the bridge resolves ITS copy of
      // the SDK, and cross-realm class identity would flake while the
      // JSON-RPC behavior stays identical.
      await expect(
        getSamplingHandler()!({
          method: 'sampling/createMessage',
          params: { messages: [], maxTokens: 8 },
        }),
      ).rejects.toThrow(/does not advertise sampling/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
