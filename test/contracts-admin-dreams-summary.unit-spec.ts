/**
 * Wire-contract drift guard for GET /v1/admin/dreams/summary.
 *
 * Also pins tenant isolation (P0): a plain brain:admin sees only its own
 * tenant's dreams runs; a platform operator (brain:platform_admin + gate)
 * keeps the all-tenant rollup.
 */
import { DreamsSummaryResponseSchema } from '../src/contracts/admin/dreams-summary.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { JobRunService } from '../src/jobs/job-run.service';
import type { AuthenticatedRequest, BrainScope } from '../src/auth/api-key.types';
import { PLATFORM_TENANT_SCOPE } from '../src/auth/tenant-scope';

const ADMIN: BrainScope[] = ['brain:admin'];
const PLATFORM: BrainScope[] = ['brain:admin', PLATFORM_TENANT_SCOPE];

function req(scopes: BrainScope[], companyId = 'tenant-a'): AuthenticatedRequest {
  return { brainAuth: { companyId, scopes, keyHash: 'h' } } as unknown as AuthenticatedRequest;
}

const OLD_GATE = process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.BRAIN_TENANT_OVERRIDE_ENABLED;
  else process.env.BRAIN_TENANT_OVERRIDE_ENABLED = OLD_GATE;
});

function makeController(): AdminJobsController {
  const jobs = {
    list: async () => [
      {
        runId: 'run-d1',
        jobType: 'dreams',
        status: 'succeeded',
        triggeredBy: 'cron',
        triggeredByActor: null,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 30_000).toISOString(),
        progress: null,
        payload: null,
        result: { identityLinksCreated: 7, resolutionsApplied: 2 },
        error: null,
        cancelRequested: false,
        companyId: 'tenant-a',
      },
    ],
  } as unknown as JobRunService;
  const undef = undefined as unknown as never;

  return new AdminJobsController(
    jobs,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
  );
}

/** Controller whose jobs.list records the filter it was called with. */
function capturingController() {
  const seen: { hasCompanyId: boolean; companyId: string | undefined } = {
    hasCompanyId: false,
    companyId: undefined,
  };
  const jobs = {
    list: async (f: { companyId?: string }) => {
      seen.hasCompanyId = Object.prototype.hasOwnProperty.call(f, 'companyId');
      seen.companyId = f.companyId;
      return [];
    },
  } as unknown as JobRunService;
  const undef = undefined as unknown as never;
  const ctrl = new AdminJobsController(
    jobs,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
    undef,
  );
  return { ctrl, seen };
}

describe('AdminJobsController.dreamsSummary() — wire contract', () => {
  it('matches DreamsSummaryResponseSchema', async () => {
    const parsed = DreamsSummaryResponseSchema.safeParse(
      await makeController().dreamsSummary(req(ADMIN)),
    );
    if (!parsed.success) {
      throw new Error(`dreams/summary drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});

describe('AdminJobsController.dreamsSummary() — tenant isolation (P0)', () => {
  it('plain brain:admin → own tenant only', async () => {
    const { ctrl, seen } = capturingController();
    await ctrl.dreamsSummary(req(ADMIN));
    expect(seen.companyId).toBe('tenant-a');
  });

  it('platform scope + gate → all tenants (no companyId filter)', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const { ctrl, seen } = capturingController();
    await ctrl.dreamsSummary(req(PLATFORM));
    expect(seen.hasCompanyId).toBe(false);
  });
});
