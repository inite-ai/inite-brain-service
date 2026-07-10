/**
 * Wire-contract drift guards for the ABAC tooling surface
 * (/v1/admin/policy/*, /v1/admin/keys).
 */
import {
  AdminKeysResponseSchema,
  PolicyDecisionsResponseSchema,
  PolicyDecisionsStatsResponseSchema,
  PolicyRegistryResponseSchema,
  SimulateActionsResponseSchema,
} from '../src/contracts/admin/policy-tools.schema';
import { AdminKeysController } from '../src/admin/admin-keys.controller';
import { AdminPolicyController } from '../src/admin/admin-policy.controller';
import { AdminPolicyDecisionsController } from '../src/admin/admin-policy-decisions.controller';
import { PolicyRegistryService } from '../src/policy/policy-registry.service';
import { PolicySimulationService } from '../src/policy/policy-simulation.service';
import { PolicyDecisionsService } from '../src/policy/policy-decisions.service';
import type { PolicyKeysService } from '../src/policy/policy-keys.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { SourcesService } from '../src/sources/sources.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { PolicyStoreService } from '../src/policy/policy-store.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

const req = {
  brainAuth: {
    companyId: 'tenant-a',
    keyHash: 'sha256:admin',
    scopes: ['brain:admin'],
  },
} as unknown as AuthenticatedRequest;

function parseOrThrow<T>(schema: { safeParse: (v: unknown) => any }, value: T, label: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
}

describe('ABAC tooling wire contracts', () => {
  it('GET /v1/admin/policy/registry matches PolicyRegistryResponseSchema', async () => {
    const registry = new PolicyRegistryService(
      {
        listAll: async () => [
          { predicateId: 'tier', status: 'active' },
          { predicateId: 'old', status: 'deprecated' },
        ],
      } as unknown as PredicateRegistryService,
      {
        list: async () => [
          { sourceKey: 'support:crm', declared: null, globalTrust: null, scopedDomains: 0 },
        ],
      } as unknown as SourcesService,
    );
    const controller = new AdminPolicyController(
      registry,
      {} as PolicySimulationService,
      {} as PolicyKeysService,
    );
    const out = await controller.registry(req);
    parseOrThrow(PolicyRegistryResponseSchema, out, 'policy registry');
    expect(out.actions.map((a) => a.name)).toContain('search_knowledge');
    expect(out.macros.find((m) => m.id === '@readonly')?.actions).toContain('graph_retrieve');
    expect(out.attributes.find((a) => a.attr === 'predicate')?.values).toEqual(['tier']);
    expect(out.attributes.find((a) => a.attr === 'source.vertical')?.values).toEqual(['support']);
  });

  it('POST simulate/actions matches SimulateActionsResponseSchema', async () => {
    const simulation = new PolicySimulationService(
      {} as never,
      {
        get: async () => ({
          name: 'readonly-agent',
          mode: 'enforce',
          document: {
            name: 'readonly-agent',
            description: '',
            posture: { actions: 'deny', reads: 'allow' },
            mode: 'enforce',
            rules: [
              { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
            ],
          },
          version: 1,
          createdAt: '',
          updatedAt: '',
          updatedBy: '',
          attachedSubjects: [],
        }),
      } as unknown as PolicyStoreService,
    );
    const controller = new AdminPolicyController(
      {} as PolicyRegistryService,
      simulation,
      {} as PolicyKeysService,
    );
    const out = await controller.simulateActions(req, {
      subject: { policyNames: ['readonly-agent'] },
    });
    parseOrThrow(SimulateActionsResponseSchema, out, 'simulate actions');
    const record = out.actions.find((a) => a.name === 'record_fact');
    expect(record?.decision).toBe('deny');
    expect(out.actions.find((a) => a.name === 'search_knowledge')?.decision).toBe('allow');
  });

  it('GET /v1/admin/keys matches AdminKeysResponseSchema', async () => {
    const keysService = {
      listKeys: async () => [
        {
          keyId: 'abc123def456',
          subject: 'key:sha256:abc123def456ff',
          name: 'support bot',
          scopes: ['brain:read'],
          policySets: [{ name: 'readonly-agent', mode: 'enforce' }],
        },
      ],
    } as unknown as PolicyKeysService;
    const controller = new AdminKeysController(keysService);
    parseOrThrow(AdminKeysResponseSchema, await controller.list(req), 'admin keys');
  });

  it('decisions feed + stats match their schemas', async () => {
    const decisions = new PolicyDecisionsService(
      {
        withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) =>
          fn({
            query: async () => [[
              {
                id: 'policy_decision:1',
                ts: '2026-07-09T10:00:00.000Z',
                keyHash: 'sha256:abcdef1234567890',
                kind: 'action',
                decision: 'would_deny',
                mode: 'report_only',
                action: 'record_fact',
                policySet: 'watcher',
                ruleId: 'ro',
                sampled: false,
              },
            ]],
          }),
      } as unknown as SurrealService,
      {
        list: async () => [
          {
            name: 'watcher',
            mode: 'report_only',
            document: {} as never,
            version: 1,
            createdAt: '2026-07-01T00:00:00Z',
            updatedAt: '2026-07-01T00:00:00Z',
            updatedBy: '',
            attachedSubjects: [],
          },
        ],
      } as unknown as PolicyStoreService,
    );
    const controller = new AdminPolicyDecisionsController(decisions);
    parseOrThrow(PolicyDecisionsResponseSchema, await controller.feed(req, {}), 'decisions feed');
    const stats = await controller.stats(req, '7');
    parseOrThrow(PolicyDecisionsStatsResponseSchema, stats, 'decisions stats');
    expect(stats.reportOnlySets[0]).toMatchObject({ name: 'watcher', wouldDeny: 1 });
    expect(stats.topDeniedActions[0]).toEqual({ action: 'record_fact', count: 1 });
  });
});
