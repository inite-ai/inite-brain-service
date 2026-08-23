/**
 * RFC 9396 grant gating on the MCP surface: with inite_mcp_resource
 * grants present, only granted actions (or 'read'/'write' kind macros)
 * stay registered; an empty grant strips everything; policy deny beats
 * grant allow. Also covers agent-attributed provenance: record_fact's
 * recorder carries the acting client id. Mirrors mcp-policy-gate spec.
 */
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriteTools } from '../src/mcp/write-tools';
import { compilePolicySet } from '../src/policy/policy-compile';
import {
  PolicyContext,
  PolicyDocument,
  PolicyDocumentSchema,
} from '../src/policy/policy.types';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};
const stubPolicyGate = {
  enforceAction: () => undefined,
  enforceToolAction: () => undefined,
};
const stubPackToolsReader = { installedPackTools: async () => [] };

function service(): McpService {
  return new McpService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    stubEmbedder as never,
    {} as never,
    {} as never,
    stubPolicyGate as never,
    stubPackToolsReader as never,
    {} as never,
  );
}

function build(opts: {
  mcpGrantedActions?: string[];
  policy?: PolicyContext;
}): Promise<McpServer> {
  return service().buildServer(
    'co_test',
    ['brain:read', 'brain:write', 'brain:admin'],
    { actorKeyHash: 'sha256:test', ...opts },
  );
}

function toolNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internals._registeredTools);
}

function ctxFromDoc(doc: Record<string, unknown>): PolicyContext {
  const parsed: PolicyDocument = PolicyDocumentSchema.parse(doc);
  const compiled = compilePolicySet(parsed);
  if (!compiled) throw new Error('disabled set in test');
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets: [compiled],
    forceReportOnly: false,
    resolutionError: false,
  };
}

describe('MCP RFC 9396 grant gate', () => {
  it('a named-action grant keeps exactly those tools', async () => {
    const names = toolNames(await build({ mcpGrantedActions: ['search_knowledge'] }));
    expect(names).toEqual(['search_knowledge']);
  });

  it("the 'read' macro grants every read tool and no write tool", async () => {
    const names = toolNames(await build({ mcpGrantedActions: ['read'] }));
    expect(names).toContain('search_knowledge');
    expect(names).toContain('graph_retrieve');
    expect(names).not.toContain('record_fact');
    expect(names).not.toContain('forget_entity');
  });

  it('an empty grant (foreign-location consent) strips every tool', async () => {
    expect(toolNames(await build({ mcpGrantedActions: [] }))).toEqual([]);
  });

  it('no grant claim = full surface (gate inactive)', async () => {
    const names = toolNames(await build({}));
    expect(names).toContain('record_fact');
    expect(names).toContain('search_knowledge');
  });

  it('policy deny overrides a grant allow', async () => {
    const policy = ctxFromDoc({
      name: 'no-forget',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [
        { id: 'nf', effect: 'deny', kind: 'action', actions: ['forget_entity'] },
      ],
    });
    const names = toolNames(
      await build({ policy, mcpGrantedActions: ['write', 'read'] }),
    );
    expect(names).not.toContain('forget_entity');
    expect(names).toContain('record_fact');
  });
});

describe('agent-attributed recorder', () => {
  it('record_fact stamps mcp_agent:<actorId> as the source recorder', async () => {
    const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: (args: unknown) => Promise<unknown>) => {
        handlers[name] = cb;
        return { remove: () => undefined };
      },
    } as unknown as McpServer;
    const seen: unknown[] = [];
    registerWriteTools({
      server: fakeServer,
      companyId: 'co_test',
      scopes: ['brain:read', 'brain:write'],
      actorKeyHash: 'sha256:test',
      actorId: 'dcr_agent1',
      deps: {
        ingest: { ingestFact: async (_c: string, dto: unknown) => (seen.push(dto), { outcome: 'INSERTED' }) },
        facts: {},
        procedural: {},
        documents: undefined,
        feedback: {},
      } as never,
    });

    await handlers['record_fact']!({
      entityRef: { entityId: 'knowledge_entity:x' },
      predicate: 'works_at',
      object: 'acme',
      validFrom: '2026-01-01T00:00:00Z',
      sourceVertical: 'chat',
    });
    expect((seen[0] as { source: { recorder: string } }).source.recorder).toBe(
      'mcp_agent:dcr_agent1',
    );
  });
});
