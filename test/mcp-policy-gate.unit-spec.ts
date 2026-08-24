/**
 * ABAC tool gating on the MCP surface: enforce-denied tools never
 * appear in the registration table (⇒ absent from tools/list), while
 * report_only policies leave the surface intact. Uses the same
 * `_registeredTools` inspection as mcp-tools.unit-spec.ts.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { compilePolicySet } from '../src/policy/policy-compile';
import { PolicyContext, PolicyDocument, PolicyDocumentSchema } from '../src/policy/policy.types';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};

const enforceCalls: string[] = [];
const stubPolicyGate = {
  enforceAction: (_ctx: PolicyContext, action: string) => {
    enforceCalls.push(action);
  },
  enforceToolAction: (_ctx: PolicyContext, action: string) => {
    enforceCalls.push(action);
  },
};

// Reader stub — individual tests override the resolved bindings.
let packBindings: unknown[] = [];
const stubPackToolsReader = {
  installedPackTools: async () => packBindings,
};

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

function buildWithPolicy(policy?: PolicyContext): Promise<McpServer> {
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
    {} as never,
    stubPolicyGate as never,
    stubPackToolsReader as never,
    {} as never, // packToolProxy
  );
  return svc.buildServer('co_test', ['brain:read', 'brain:write', 'brain:admin'], {
    actorKeyHash: 'sha256:test',
    ...(policy !== undefined ? { policy } : {}),
  });
}

function toolNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internals._registeredTools);
}

// Resources register under _registeredResourceTemplates (ResourceTemplate
// path). Same private-field inspection the tool tests use.
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

describe('MCP ABAC tool gate', () => {
  it('readonly enforce policy strips every write tool from the surface', async () => {
    const policy = ctxFromDoc({
      name: 'readonly-agent',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [{ id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] }],
    });
    const names = toolNames(await buildWithPolicy(policy));
    expect(names).toContain('search_knowledge');
    expect(names).toContain('graph_retrieve');
    expect(names).toContain('get_source_reputation');
    expect(names).not.toContain('record_fact');
    expect(names).not.toContain('retract_fact');
    expect(names).not.toContain('forget_entity');
    expect(names).not.toContain('ingest_document');
    expect(names).not.toContain('record_procedure');
  });

  it('a targeted deny removes exactly that tool', async () => {
    const policy = ctxFromDoc({
      name: 'no-forget',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [{ id: 'nf', effect: 'deny', kind: 'action', actions: ['forget_entity'] }],
    });
    const names = toolNames(await buildWithPolicy(policy));
    expect(names).not.toContain('forget_entity');
    expect(names).toContain('record_fact');
    expect(names).toContain('search_knowledge');
  });

  it('report_only policy leaves the full surface registered', async () => {
    const policy = ctxFromDoc({
      name: 'watcher',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'report_only',
      rules: [],
    });
    const withPolicy = toolNames(await buildWithPolicy(policy)).sort();
    const without = toolNames(await buildWithPolicy(undefined)).sort();
    expect(withPolicy).toEqual(without);
  });

  it('no policy context = pre-ABAC surface, gate service untouched', async () => {
    enforceCalls.length = 0;
    const names = toolNames(await buildWithPolicy(undefined));
    expect(names).toContain('record_fact');
    expect(names).toContain('forget_entity');
    expect(enforceCalls).toHaveLength(0);
  });
});

// The resource surface (brain://entity/<id>[/timeline]) rides the SAME
// ABAC gate as tools: each resource resolves to its equivalent read
// tool's action, so a policy verdict on get_entity_profile /
// get_entity_timeline governs the matching resource identically. Before
// the fix, registerResource was never wrapped — an enforce-denied token
// still read these resources (base brain:read + tenant fence only).
describe('MCP ABAC gate over resources', () => {
  it('a readonly-allow enforce policy keeps both entity resources', async () => {
    const policy = ctxFromDoc({
      name: 'readonly-agent',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [{ id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] }],
    });
    const names = resourceNames(await buildWithPolicy(policy));
    expect(names).toContain('entity-profile');
    expect(names).toContain('entity-timeline');
  });

  it('a targeted deny on get_entity_profile removes exactly that resource', async () => {
    const policy = ctxFromDoc({
      name: 'no-profile',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [{ id: 'np', effect: 'deny', kind: 'action', actions: ['get_entity_profile'] }],
    });
    const server = await buildWithPolicy(policy);
    // Tool + resource for the denied entity read both vanish…
    expect(toolNames(server)).not.toContain('get_entity_profile');
    expect(resourceNames(server)).not.toContain('entity-profile');
    // …while the timeline read (tool + resource) is untouched.
    expect(toolNames(server)).toContain('get_entity_timeline');
    expect(resourceNames(server)).toContain('entity-timeline');
  });

  it('an actions-deny posture with no allow strips every resource', async () => {
    const policy = ctxFromDoc({
      name: 'deny-all',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [],
    });
    expect(resourceNames(await buildWithPolicy(policy))).toEqual([]);
  });

  it('report_only policy leaves the resource surface intact', async () => {
    const policy = ctxFromDoc({
      name: 'watcher',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'report_only',
      rules: [],
    });
    const withPolicy = resourceNames(await buildWithPolicy(policy)).sort();
    const without = resourceNames(await buildWithPolicy(undefined)).sort();
    expect(withPolicy).toEqual(without);
    expect(without).toContain('entity-profile');
  });
});

describe('MCP ABAC gate over pack-declared tools', () => {
  // Pack tool names are OUTSIDE the static action registry, where
  // unknown names default to write-kind. The explicit kind map built in
  // buildServer (query=read, external=write) is what these tests pin.
  const demoBinding = {
    packId: 'demo',
    version: '0.1.0',
    installId: 'inst-1',
    webhookSecret: 'sec',
    tools: [
      {
        kind: 'query',
        name: 'find_things',
        description: 'Find things.',
        query: { surface: 'search' },
      },
    ],
    namespacedPredicates: new Set(['demo__thing']),
  };

  beforeEach(() => {
    process.env.MCP_PACK_TOOLS_ENABLED = '1';
    packBindings = [demoBinding];
  });
  afterEach(() => {
    delete process.env.MCP_PACK_TOOLS_ENABLED;
    packBindings = [];
  });

  it('a pack QUERY tool registers under a readonly-allow enforce policy', async () => {
    const policy = ctxFromDoc({
      name: 'readonly-agent',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [{ id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] }],
    });
    const names = toolNames(await buildWithPolicy(policy));
    expect(names).toContain('demo__find_things');
    expect(names).not.toContain('record_fact');
  });

  it('an enforce-deny on the concrete namespaced name removes exactly that tool', async () => {
    const policy = ctxFromDoc({
      name: 'no-demo-tool',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [
        {
          id: 'nd',
          effect: 'deny',
          kind: 'action',
          actions: ['demo__find_things'],
        },
      ],
    });
    const names = toolNames(await buildWithPolicy(policy));
    expect(names).not.toContain('demo__find_things');
    expect(names).toContain('search_knowledge');
  });

  it('an EXTERNAL pack tool is write-kind: stripped by a readonly-allow policy', async () => {
    process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED = '1';
    try {
      packBindings = [
        {
          ...demoBinding,
          tools: [
            {
              kind: 'external',
              name: 'call_home',
              description: 'Calls the publisher.',
              endpoint: 'https://tools.example.com/hook',
            },
          ],
        },
      ];
      // Registers when no policy restricts the surface…
      const open = toolNames(await buildWithPolicy(undefined));
      expect(open).toContain('demo__call_home');
      // …and is removed under readonly-allow, because its explicit kind
      // is write (the whole point of the kind map: an external tool must
      // never ride the read macro).
      const policy = ctxFromDoc({
        name: 'readonly-agent',
        posture: { actions: 'deny', reads: 'allow' },
        mode: 'enforce',
        rules: [{ id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] }],
      });
      const names = toolNames(await buildWithPolicy(policy));
      expect(names).not.toContain('demo__call_home');
      expect(names).toContain('search_knowledge');
    } finally {
      delete process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED;
    }
  });
});

// Resource handlers get the SAME error sanitization as tools: a resource
// has no isError result channel, so a thrown handler error would be
// serialized into the JSON-RPC error message verbatim (raw SurrealDB
// text: record ids, index names, FIELD VALUES). The wrapper is active
// regardless of policy/grant, so these build with neither.
describe('MCP resource handler error sanitization', () => {
  // entities is the 2nd constructor arg; a throwing stub drives the
  // resource handler's error path. Everything else is a bare stub.
  function buildWithEntities(entities: unknown): Promise<McpServer> {
    const svc = new McpService(
      {} as never, // search
      entities as never, // entities
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
      stubEmbedder as never, // embedder
      {} as never, // documents
      {} as never, // feedback
      stubPolicyGate as never, // policyGate (unused without a policy)
      stubPackToolsReader as never,
      {} as never, // packToolProxy
    );
    return svc.buildServer('co_test', ['brain:read'], { actorKeyHash: 'sha256:test' });
  }

  function resourceReadCallback(
    server: McpServer,
    name: string,
  ): (uri: URL, params: Record<string, unknown>) => Promise<unknown> {
    const internals = server as unknown as {
      _registeredResourceTemplates: Record<
        string,
        { readCallback: (uri: URL, params: Record<string, unknown>) => Promise<unknown> }
      >;
    };
    return internals._registeredResourceTemplates[name]!.readCallback;
  }

  it('replaces a raw resource DB error with a generic ref (no leak)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const server = await buildWithEntities({
        getProfile: async () => {
          throw new Error('SurrealDB parse error at knowledge_entity:e1 value=SSN-999-12-3456');
        },
      });
      const cb = resourceReadCallback(server, 'entity-profile');
      let thrown: Error | undefined;
      try {
        await cb(new URL('brain://entity/e1'), { entityId: 'e1' });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      // Client sees a generic message — never the raw DB text or PII value.
      expect(thrown?.message).toMatch(
        /internal error while reading resource entity-profile \(ref /,
      );
      expect(thrown?.message).not.toContain('SSN-999');
      expect(thrown?.message).not.toContain('SurrealDB');
      // …but the full detail is logged for ops (correlation ref).
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('SSN-999');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('passes a deliberate NotFoundException through unchanged (matches tools)', async () => {
    const server = await buildWithEntities({
      getProfile: async () => {
        throw new NotFoundException('Entity e1 not found');
      },
    });
    const cb = resourceReadCallback(server, 'entity-profile');
    // HttpException < 500 is a client-facing error: not masked, same as
    // the tool wrapper and the REST surface.
    await expect(cb(new URL('brain://entity/e1'), { entityId: 'e1' })).rejects.toThrow(
      'Entity e1 not found',
    );
  });
});
