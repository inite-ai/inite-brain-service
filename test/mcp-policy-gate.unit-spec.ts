/**
 * ABAC tool gating on the MCP surface: enforce-denied tools never
 * appear in the registration table (⇒ absent from tools/list), while
 * report_only policies leave the surface intact. Uses the same
 * `_registeredTools` inspection as mcp-tools.unit-spec.ts.
 */
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

describe('MCP ABAC tool gate', () => {
  it('readonly enforce policy strips every write tool from the surface', async () => {
    const policy = ctxFromDoc({
      name: 'readonly-agent',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
      ],
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
      rules: [
        { id: 'nf', effect: 'deny', kind: 'action', actions: ['forget_entity'] },
      ],
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
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
      ],
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
        rules: [
          { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
        ],
      });
      const names = toolNames(await buildWithPolicy(policy));
      expect(names).not.toContain('demo__call_home');
      expect(names).toContain('search_knowledge');
    } finally {
      delete process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED;
    }
  });
});
