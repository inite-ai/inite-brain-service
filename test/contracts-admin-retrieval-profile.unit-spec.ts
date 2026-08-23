/**
 * Wire-contract drift guard for GET /v1/admin/retrieval-profile.
 *
 * Outside a request (no ALS store) the controller falls back to
 * resolving the profile for the authenticated companyId — that is the
 * path exercised here; the schema also pins that `lanes` reaches the
 * wire as a sorted ARRAY (the in-process ReadonlySet would serialize
 * to {}).
 */
import {
  RetrievalProfileResponseSchema,
  RetrievalProfileWireSchema,
} from '../src/contracts/admin/retrieval-profile.schema';
import { makeAdminInfraController } from './helpers/admin-controllers';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

const req = (companyId: string): AuthenticatedRequest =>
  ({ brainAuth: { companyId } }) as AuthenticatedRequest;

describe('AdminInfraController.retrievalProfile() — wire contract', () => {
  const savedRouter = process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;

  afterEach(() => {
    if (savedRouter === undefined) {
      delete process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED;
    } else {
      process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = savedRouter;
    }
  });

  it('matches RetrievalProfileResponseSchema', () => {
    const out = makeAdminInfraController().retrievalProfile(req('tenant-x'));
    const parsed = RetrievalProfileResponseSchema.safeParse(out);
    if (!parsed.success) {
      throw new Error(`retrieval-profile drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.data.companyId).toBe('tenant-x');
  });

  it('covers every RetrievalProfile field — both directions', () => {
    // A plain z.object silently STRIPS unknown keys, so the safeParse
    // above cannot catch a profile field the wire schema forgot. This
    // pins key-set equality: a new profile field without a schema entry
    // (or a schema entry without a profile field) fails loudly.
    const out = makeAdminInfraController().retrievalProfile(req('tenant-x'));
    const wireKeys = Object.keys(RetrievalProfileWireSchema.shape).sort();
    const actualKeys = Object.keys(out.profile).sort();
    expect(wireKeys).toEqual(actualKeys);
  });

  it('serializes lanes as a sorted array, not a Set', () => {
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    const out = makeAdminInfraController().retrievalProfile(req('tenant-x'));
    expect(Array.isArray(out.profile.lanes)).toBe(true);
    expect(out.profile.lanes.length).toBeGreaterThan(0);
    expect(out.profile.lanes).toEqual([...out.profile.lanes].sort());
  });
});
