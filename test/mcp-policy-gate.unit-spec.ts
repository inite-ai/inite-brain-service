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

function buildWithPolicy(policy?: PolicyContext): McpServer {
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
  );
  return svc.buildServer('co_test', ['brain:read', 'brain:write', 'brain:admin'], {
    actorKeyHash: 'sha256:test',
    policy,
  });
}

function toolNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internals._registeredTools);
}

describe('MCP ABAC tool gate', () => {
  it('readonly enforce policy strips every write tool from the surface', () => {
    const policy = ctxFromDoc({
      name: 'readonly-agent',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'enforce',
      rules: [
        { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
      ],
    });
    const names = toolNames(buildWithPolicy(policy));
    expect(names).toContain('search_knowledge');
    expect(names).toContain('graph_retrieve');
    expect(names).toContain('get_source_reputation');
    expect(names).not.toContain('record_fact');
    expect(names).not.toContain('retract_fact');
    expect(names).not.toContain('forget_entity');
    expect(names).not.toContain('ingest_document');
    expect(names).not.toContain('record_procedure');
  });

  it('a targeted deny removes exactly that tool', () => {
    const policy = ctxFromDoc({
      name: 'no-forget',
      posture: { actions: 'allow', reads: 'allow' },
      mode: 'enforce',
      rules: [
        { id: 'nf', effect: 'deny', kind: 'action', actions: ['forget_entity'] },
      ],
    });
    const names = toolNames(buildWithPolicy(policy));
    expect(names).not.toContain('forget_entity');
    expect(names).toContain('record_fact');
    expect(names).toContain('search_knowledge');
  });

  it('report_only policy leaves the full surface registered', () => {
    const policy = ctxFromDoc({
      name: 'watcher',
      posture: { actions: 'deny', reads: 'allow' },
      mode: 'report_only',
      rules: [],
    });
    const withPolicy = toolNames(buildWithPolicy(policy)).sort();
    const without = toolNames(buildWithPolicy(undefined)).sort();
    expect(withPolicy).toEqual(without);
  });

  it('no policy context = pre-ABAC surface, gate service untouched', () => {
    enforceCalls.length = 0;
    const names = toolNames(buildWithPolicy(undefined));
    expect(names).toContain('record_fact');
    expect(names).toContain('forget_entity');
    expect(enforceCalls).toHaveLength(0);
  });
});
