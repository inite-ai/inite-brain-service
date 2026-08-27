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
import { ACTIONS } from '../src/policy/action-registry';
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
    const names = toolNames(await buildWithScopes(['brain:read', 'brain:write', 'brain:admin']));
    expect(names).toContain('forget_entity');
  });

  it('registers brain://entity/ + /timeline resources at brain:read', async () => {
    const names = resourceNames(await buildWithScopes(['brain:read']));
    expect(names).toContain('entity-profile');
    expect(names).toContain('entity-timeline');
  });

  it('does NOT register get_fact / get_fact_provenance with FACTS_API_ENABLED off (default)', async () => {
    // Gating parity with REST: facts.controller 404s the GET routes when
    // the flag is off ("indistinguishable from an absent route"); the MCP
    // twin of an absent route is an absent tool.
    const names = toolNames(await buildWithScopes(['brain:read']));
    expect(names).not.toContain('get_fact');
    expect(names).not.toContain('get_fact_provenance');
  });

  it('registers get_fact / get_fact_provenance under FACTS_API_ENABLED with a factId input', async () => {
    const prev = process.env.FACTS_API_ENABLED;
    process.env.FACTS_API_ENABLED = '1';
    try {
      const server = await buildWithScopes(['brain:read']);
      const names = toolNames(server);
      expect(names).toContain('get_fact');
      expect(names).toContain('get_fact_provenance');
      const internals = server as unknown as {
        _registeredTools: Record<string, { inputSchema?: { shape?: object } }>;
      };
      for (const t of ['get_fact', 'get_fact_provenance']) {
        expect(Object.keys(internals._registeredTools[t]!.inputSchema?.shape ?? {})).toEqual([
          'factId',
        ]);
      }
    } finally {
      if (prev === undefined) delete process.env.FACTS_API_ENABLED;
      else process.env.FACTS_API_ENABLED = prev;
    }
  });

  it('get_fact / get_fact_provenance tool names map to read actions in the policy registry', () => {
    // The ABAC tool gate and the RFC 9396 grant gate both resolve a tool
    // by NAME through ACTIONS — name-equality with the registry entry IS
    // the wiring. Both must be read-kind (grant macro 'read' covers them;
    // any policy over the REST route governs the MCP tool identically).
    expect(ACTIONS['get_fact']).toMatchObject({ kind: 'read' });
    expect(ACTIONS['get_fact_provenance']).toMatchObject({ kind: 'read' });
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
    // Flag-gated read tools stay OFF the probe too: HEALTH_TOOLS is the
    // always-present read baseline, and get_fact / get_fact_provenance
    // exist only under FACTS_API_ENABLED (default off) — listing them
    // would make the probe advertise tools a default deployment lacks.
    expect(health.tools).not.toContain('get_fact');
    expect(health.tools).not.toContain('get_fact_provenance');
    expect(health.embedder).toBe('openai:text-embedding-3-small (1536d)');
  });
});

describe('get_fact / get_fact_provenance — delegation to FactsService', () => {
  // detect_contradiction-style delegation: the tool is a thin seam over
  // the SAME service method the REST route calls, forwarding the tenant
  // pin and the caller's scope set (every visibility fence lives in
  // FactsService; omitting scopes would skip the row-policy filter).
  async function buildFactHandlers(factsStub: object): Promise<{
    handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    scopes: BrainScope[];
  }> {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    const fakeServer = {
      registerTool: (
        name: string,
        _meta: unknown,
        cb: (args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        handlers[name] = cb;
      },
      registerResource: () => ({ remove: () => undefined }),
    };
    const scopes: BrainScope[] = ['brain:read'];
    const { registerReadTools } = await import('../src/mcp/read-tools');
    registerReadTools({
      server: fakeServer as never,
      companyId: 'co_test',
      scopes,
      deps: {
        search: {} as never,
        entities: {} as never,
        facts: factsStub as never,
        multiHop: {} as never,
        synth: {} as never,
        memoryDiff: {} as never,
        predictor: {} as never,
        summarizer: {} as never,
        embedderDescription: () => 'stub-embedder',
      },
    });
    return { handlers, scopes };
  }

  const prevFlag = process.env.FACTS_API_ENABLED;
  beforeAll(() => {
    process.env.FACTS_API_ENABLED = '1';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.FACTS_API_ENABLED;
    else process.env.FACTS_API_ENABLED = prevFlag;
  });

  it('get_fact forwards {companyId, factId, scopes} and returns the service result verbatim', async () => {
    const captured: unknown[] = [];
    const serviceResult = {
      factId: 'knowledge_fact:f1',
      aspect: 'status',
      statement: 'active',
      confidence: 0.9,
      validFrom: '2026-01-01T00:00:00.000Z',
      retracted: false,
      groundingStatus: 'grounded',
    };
    const { handlers, scopes } = await buildFactHandlers({
      getFact: async (o: unknown) => {
        captured.push(o);
        return serviceResult;
      },
    });
    const out = (await handlers['get_fact']!({ factId: 'f1' })) as {
      structuredContent: unknown;
    };
    expect(captured).toEqual([{ companyId: 'co_test', factId: 'f1', scopes }]);
    // Passthrough — no field filtering; groundingStatus rides through.
    expect(out.structuredContent).toEqual(serviceResult);
  });

  it('get_fact_provenance forwards {companyId, factId, scopes} and passes the shape through', async () => {
    const captured: unknown[] = [];
    const serviceResult = {
      factId: 'knowledge_fact:f1',
      episodes: [],
      derivedFacts: [
        { factId: 'knowledge_fact:f0', predicate: 'status', depth: 1, status: 'active' },
      ],
      closure: { depth: 1, factCount: 1, truncated: false, filtered: false },
    };
    const { handlers, scopes } = await buildFactHandlers({
      getProvenance: async (o: unknown) => {
        captured.push(o);
        return serviceResult;
      },
    });
    const out = (await handlers['get_fact_provenance']!({ factId: 'f1' })) as {
      structuredContent: unknown;
    };
    expect(captured).toEqual([{ companyId: 'co_test', factId: 'f1', scopes }]);
    // Passthrough — recursive-closure fields (derivedFacts / closure)
    // ride the service response untouched as server-side flags land.
    expect(out.structuredContent).toEqual(serviceResult);
  });
});

describe('ingest_document — toolObservationRef plumbing (0111 loop over MCP)', () => {
  it('passes toolObservationRef through to DocumentIngestService, and omits it when absent', async () => {
    const prev = process.env.DOCUMENT_INGEST_ENABLED;
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    try {
      const captured: Array<Record<string, unknown>> = [];
      const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
      const configs: Record<string, { inputSchema?: Record<string, unknown> }> = {};
      const fakeServer = {
        registerTool: (
          name: string,
          config: { inputSchema?: Record<string, unknown> },
          cb: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          handlers[name] = cb;
          configs[name] = config;
        },
      };
      const { registerWriteTools } = await import('../src/mcp/write-tools');
      registerWriteTools({
        server: fakeServer as never,
        companyId: 'co_test',
        scopes: ['brain:read', 'brain:write'],
        deps: {
          ingest: {} as never,
          facts: {} as never,
          procedural: {} as never,
          documents: {
            ingestDocument: async (_companyId: string, dto: Record<string, unknown>) => {
              captured.push(dto);
              return { documentId: 'document:d1', outcome: 'INGESTED' };
            },
          } as never,
        },
      });

      // The MCP input schema advertises the field (the DTO accepted it
      // all along — the schema was the missing half of the 0111 loop).
      expect(Object.keys(configs['ingest_document']!.inputSchema ?? {})).toContain(
        'toolObservationRef',
      );

      const base = {
        kind: 'chat',
        text: 'tool result body',
        occurredAt: '2026-08-01T00:00:00.000Z',
        vertical: 'agent',
      };
      await handlers['ingest_document']!({
        ...base,
        toolObservationRef: 'tool_observation:obs1',
      });
      expect(captured[0]!['toolObservationRef']).toBe('tool_observation:obs1');

      await handlers['ingest_document']!(base);
      // Absent must stay ABSENT (exactOptionalPropertyTypes discipline):
      // the service treats the key's presence as the 0111 opt-in.
      expect('toolObservationRef' in captured[1]!).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DOCUMENT_INGEST_ENABLED;
      else process.env.DOCUMENT_INGEST_ENABLED = prev;
    }
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
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
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
    expect((captured[0] as { callerScopes?: unknown }).callerScopes).toEqual(scopes);
  });
});
