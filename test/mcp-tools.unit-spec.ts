/**
 * Smoke coverage for the MCP tool-registration surface.
 *
 * Three things we pin:
 *
 * 1. Read-scope baseline — every read tool registers regardless of
 *    write/admin presence: search_knowledge, search_multi_hop,
 *    synthesize, get_entity_profile, get_entity_timeline,
 *    find_related_entities.
 *
 * 2. brain:write gate — record_fact, retract_fact, link_entities
 *    only register when the caller has brain:write. Without it, a
 *    caller can't drive any mutation from an agent loop.
 *
 * 3. brain:admin gate — forget_entity ONLY registers under
 *    brain:admin. GDPR cascade is irreversible; we don't want it on
 *    a key that only carries brain:write.
 *
 * Inspecting registrations: the SDK keeps tools in a private field
 * `_registeredTools` (a record keyed by tool name). We cast to read
 * it for the test only — production code never touches it.
 */
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrainScope } from '../src/auth/api-key.types';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};

// Pack-tools reader — flag off in unit tests, but buildServer still
// holds the dep; an empty read keeps the pre-pack surface identical.
const stubPackToolsReader = { installedPackTools: async () => [] };

function buildWithScopes(scopes: BrainScope[]): Promise<McpServer> {
  const svc = new McpService(
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
    {} as never, // feedback
    {} as never, // policyGate — unused without a policy context
    stubPackToolsReader as never,
    {} as never, // packToolProxy — no external tools in these fixtures
  );
  return svc.buildServer('co_test', scopes);
}

function toolNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internals._registeredTools);
}

function resourceNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredResources?: Record<string, unknown>;
    _registeredResourceTemplates?: Record<string, unknown>;
  };
  return [
    ...Object.keys(internals._registeredResources ?? {}),
    ...Object.keys(internals._registeredResourceTemplates ?? {}),
  ];
}

const READ_BASELINE = [
  'search_knowledge',
  'search_multi_hop',
  'graph_retrieve',
  'synthesize',
  'memory_diff',
  'get_entity_profile',
  'get_entity_timeline',
  'summarize_entity',
  'get_competing_facts',
  'detect_contradiction',
  'match_procedure',
  'list_procedures',
  'search_communities',
  'list_communities',
  'find_entity_communities',
  'find_related_entities',
  'why',
  'recall_decisions',
  'get_source_reputation',
];

describe('McpService.buildServer — scope-gated tool surface', () => {
  it('registers the read baseline with only brain:read', async () => {
    const names = toolNames(await buildWithScopes(['brain:read']));
    for (const t of READ_BASELINE) expect(names).toContain(t);
  });

  it('does NOT register mutation tools without brain:write', async () => {
    const names = toolNames(await buildWithScopes(['brain:read']));
    expect(names).not.toContain('record_fact');
    expect(names).not.toContain('retract_fact');
    expect(names).not.toContain('link_entities');
    expect(names).not.toContain('record_feedback');
    expect(names).not.toContain('record_procedure');
    expect(names).not.toContain('retire_procedure');
    expect(names).not.toContain('record_decision');
  });

  it('registers mutation tools when brain:write is present', async () => {
    const names = toolNames(await buildWithScopes(['brain:read', 'brain:write']));
    expect(names).toContain('record_fact');
    expect(names).toContain('retract_fact');
    expect(names).toContain('link_entities');
    expect(names).toContain('record_feedback');
    expect(names).toContain('record_procedure');
    expect(names).toContain('retire_procedure');
    expect(names).toContain('record_decision');
  });

  it('does NOT register forget_entity without brain:admin (even with write)', async () => {
    const names = toolNames(await buildWithScopes(['brain:read', 'brain:write']));
    expect(names).not.toContain('forget_entity');
  });

  it('registers forget_entity only with brain:admin', async () => {
    const names = toolNames(
      await buildWithScopes(['brain:read', 'brain:write', 'brain:admin']),
    );
    expect(names).toContain('forget_entity');
  });

  it('registers brain://entity/ + /timeline resources at brain:read', async () => {
    const names = resourceNames(await buildWithScopes(['brain:read']));
    expect(names).toContain('entity-profile');
    expect(names).toContain('entity-timeline');
  });

  it('ingest_document exposes the indexers param (REST parity: auto routes packs)', async () => {
    const prev = process.env.DOCUMENT_INGEST_ENABLED;
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    try {
      const server = await buildWithScopes(['brain:read', 'brain:write']);
      const internals = server as unknown as {
        _registeredTools: Record<string, { inputSchema?: { shape?: object } }>;
      };
      const tool = internals._registeredTools['ingest_document'];
      expect(tool).toBeDefined();
      // Before the fix the tool hardcoded indexers:'general' with no way to
      // opt into domain-pack routing that the REST twin accepts.
      expect(Object.keys(tool!.inputSchema?.shape ?? {})).toContain('indexers');
    } finally {
      if (prev === undefined) delete process.env.DOCUMENT_INGEST_ENABLED;
      else process.env.DOCUMENT_INGEST_ENABLED = prev;
    }
  });
});

describe('McpService.health — unauthenticated probe payload', () => {
  it('returns ok, version, the read-baseline tools, and embedder hint', () => {
    const svc = new McpService(
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
      {} as never, // feedback
      {} as never, // policyGate — unused without a policy context
      stubPackToolsReader as never,
      {} as never, // packToolProxy
    );
    const health = svc.health();
    expect(health.ok).toBe(true);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const t of READ_BASELINE) {
      expect(health.tools).toContain(t);
    }
    // Write- and admin-only tools must NOT leak through the unauth
    // probe — the brain:write / brain:admin gates are the wire's only
    // line of defence; surfacing them in /health would tell a probe
    // exactly what it doesn't have permission to call.
    expect(health.tools).not.toContain('record_fact');
    expect(health.tools).not.toContain('forget_entity');
    expect(health.embedder).toBe('openai:text-embedding-3-small (1536d)');
  });
});

describe('retract_fact — caller scopes reach FactsService', () => {
  // Regression: the MCP path used to call facts.retract WITHOUT
  // callerScopes; FactsService treats undefined as a legacy in-process
  // caller and SKIPS the predicate-class gate (billing_event /
  // human_declared / legal-source require brain:admin) — so a bare
  // brain:write MCP key could retract admin-class facts the HTTP path
  // would 403. Pin that the tool forwards the caller's scopes.
  it('forwards the MCP caller scope set to facts.retract', async () => {
    const captured: unknown[] = [];
    const handlers: Record<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    > = {};
    const fakeServer = {
      registerTool: (
        name: string,
        _meta: unknown,
        cb: (args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        handlers[name] = cb;
      },
    };
    const scopes: BrainScope[] = ['brain:read', 'brain:write'];

    const { registerWriteTools } = await import('../src/mcp/write-tools');
    registerWriteTools({
      server: fakeServer as never,
      companyId: 'co_test',
      scopes,
      deps: {
        ingest: {} as never,
        procedural: {} as never,
        facts: {
          retract: async (o: unknown) => {
            captured.push(o);
            return { factId: 'knowledge_fact:x', retractedAt: 'now' };
          },
        } as never,
      },
    });

    await handlers['retract_fact']!({ factId: 'x', reason: 'test' });

    expect(captured).toHaveLength(1);
    expect((captured[0] as { callerScopes?: unknown }).callerScopes).toEqual(
      scopes,
    );
  });
});
