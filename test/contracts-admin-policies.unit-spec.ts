/**
 * Wire-contract drift guard for the /v1/admin/policy-sets surface.
 */
import {
  PolicySetsListResponseSchema,
  PolicySetResponseSchema,
  PolicyBindingsResponseSchema,
} from '../src/contracts/admin/policies.schema';
import { AdminPoliciesController } from '../src/admin/admin-policies.controller';
import type { PolicyStoreService, StoredPolicySet } from '../src/policy/policy-store.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

const STORED: StoredPolicySet = {
  name: 'support-reader',
  mode: 'report_only',
  document: {
    name: 'support-reader',
    description: 'support agents',
    posture: { actions: 'deny', reads: 'deny' },
    mode: 'report_only',
    rules: [
      { id: 'ro', effect: 'allow', kind: 'action', enabled: true, actions: ['@readonly'] },
      {
        id: 'support-only',
        effect: 'allow',
        kind: 'source',
        enabled: true,
        match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
      },
    ],
  },
  version: 3,
  createdAt: '2026-07-09T00:00:00Z',
  updatedAt: '2026-07-09T01:00:00Z',
  updatedBy: 'sha256:abcdef',
  attachedSubjects: ['key:sha256:1234'],
};

function makeController(): AdminPoliciesController {
  const store = {
    list: async () => [STORED],
    get: async () => STORED,
    listBindings: async () => [
      {
        subject: 'key:sha256:1234',
        policyNames: ['support-reader'],
        updatedAt: '2026-07-09T01:00:00Z',
      },
    ],
  } as unknown as PolicyStoreService;
  return new AdminPoliciesController(store);
}

const req = {
  brainAuth: { companyId: 'tenant-a', keyHash: 'sha256:admin' },
} as AuthenticatedRequest;

describe('AdminPoliciesController — wire contracts', () => {
  it('list() matches PolicySetsListResponseSchema', async () => {
    const parsed = PolicySetsListResponseSchema.safeParse(await makeController().list(req));
    if (!parsed.success) {
      throw new Error(`policy-sets list drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('get() matches PolicySetResponseSchema', async () => {
    const parsed = PolicySetResponseSchema.safeParse(
      await makeController().get(req, 'support-reader'),
    );
    if (!parsed.success) {
      throw new Error(`policy-set get drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('bindings() matches PolicyBindingsResponseSchema', async () => {
    const parsed = PolicyBindingsResponseSchema.safeParse(await makeController().bindings(req));
    if (!parsed.success) {
      throw new Error(`policy bindings drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});
