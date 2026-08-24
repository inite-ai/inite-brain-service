/**
 * Wire-contract drift guard for GET /v1/admin/jobs.
 *
 * The Phase J/K addition of payload / cancelRequested / attempts /
 * claimedBy / leaseUntil / heartbeatAt / visibleAfter to JobRunRow
 * silently drifted the admin panel until G1 patched the ad-hoc
 * interface. This test pins the wire shape: if a new field appears
 * on the row that JobsListResponseSchema doesn't model, the schema
 * still passes (zod ignores unknown keys by default) — but if a
 * declared field changes type, this test breaks and the BFF 502s
 * in prod. The intent is to make adding-a-field-to-the-protocol an
 * explicit, two-side change.
 *
 * Also pins the tenant isolation of the companyId query (P0): a plain
 * brain:admin can only ever list its own tenant's jobs; a foreign
 * companyId is a 403 unless the caller holds brain:platform_admin AND
 * BRAIN_TENANT_OVERRIDE_ENABLED is on.
 */
import { ForbiddenException } from '@nestjs/common';
import { JobsListResponseSchema } from '../src/contracts/admin/jobs.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { JobRunService } from '../src/jobs/job-run.service';
import type { AuthenticatedRequest, BrainScope } from '../src/auth/api-key.types';
import { PLATFORM_TENANT_SCOPE } from '../src/auth/tenant-scope';

const KNOWN = ['tenant-a', 'tenant-b'];
const apiKeys = { knownCompanyIds: () => KNOWN } as never;
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

function makeJobs(): JobRunService {
  return {
    list: async () => [
      {
        runId: 'run-1',
        jobType: 'dreams',
        status: 'running',
        triggeredBy: 'cron',
        triggeredByActor: null,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: null,
        progress: { processed: 10, total: 100 },
        payload: null,
        result: null,
        error: null,
        cancelRequested: false,
        attempts: 1,
        claimedBy: 'pod-1#42',
        claimedAt: new Date(Date.now() - 60_000).toISOString(),
        leaseUntil: new Date(Date.now() + 30_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
        visibleAfter: null,
        companyId: 'tenant-a',
      },
      {
        runId: 'run-2',
        jobType: 'compaction',
        status: 'succeeded',
        triggeredBy: 'manual',
        triggeredByActor: 'operator@example.com',
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        progress: null,
        payload: null,
        result: { skipped: false, factsConsidered: 42 },
        error: null,
        cancelRequested: false,
        companyId: 'tenant-b',
      },
    ],
  } as unknown as JobRunService;
}

function makeController(jobs: JobRunService): AdminJobsController {
  const undef = undefined as unknown as never;
  return new AdminJobsController(
    jobs, // 0 jobs
    undef, // 1 dreams
    undef, // 2 calibrationRefit
    undef, // 3 changefeed
    undef, // 4 scheduler
    apiKeys, // 5 apiKeys
    undef, // 6 reindex
    undef, // 7 scenarios
    undef, // 8 claim
    undef, // 9 leaderLease
    undef, // 10 workerLoop
    undef, // 11 workerPool
    undef, // 12 compaction
    undef, // 13 config
  );
}

/** Jobs mock that captures the filter the controller passes to list(). */
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
  return { ctrl: makeController(jobs), seen };
}

describe('AdminJobsController.listJobs() — wire contract', () => {
  it('matches JobsListResponseSchema with mixed-status rows', async () => {
    const controller = makeController(makeJobs());
    const payload = await controller.listJobs(req(ADMIN));
    const parsed = JobsListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `controller drifted from JobsListResponseSchema: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.data.jobs).toHaveLength(2);
    // Pin Phase J/K fields — they're the ones that historically drifted.
    expect(parsed.data.jobs[0]).toHaveProperty('cancelRequested');
    expect(parsed.data.jobs[0]).toHaveProperty('attempts');
    expect(parsed.data.jobs[0]).toHaveProperty('claimedBy');
    expect(parsed.data.jobs[0]).toHaveProperty('leaseUntil');
    expect(parsed.data.jobs[0]).toHaveProperty('heartbeatAt');
  });

  it('accepts an empty list', async () => {
    const empty = {
      list: async () => [],
    } as unknown as JobRunService;
    const controller = makeController(empty);
    const parsed = JobsListResponseSchema.safeParse(await controller.listJobs(req(ADMIN)));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.jobs).toHaveLength(0);
  });
});

describe('AdminJobsController.listJobs() — tenant isolation (P0)', () => {
  it('plain brain:admin, companyId omitted → own tenant only', async () => {
    const { ctrl, seen } = capturingController();
    await ctrl.listJobs(req(ADMIN));
    expect(seen.companyId).toBe('tenant-a');
  });

  it('plain brain:admin, foreign companyId → 403', async () => {
    const { ctrl } = capturingController();
    await expect(
      ctrl.listJobs(req(ADMIN), undefined, undefined, undefined, 'tenant-b'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('platform scope + gate on, foreign companyId → allowed (that tenant)', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const { ctrl, seen } = capturingController();
    await ctrl.listJobs(req(PLATFORM), undefined, undefined, undefined, 'tenant-b');
    expect(seen.companyId).toBe('tenant-b');
  });

  it('platform scope + gate on, companyId omitted → all tenants (no filter)', async () => {
    process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
    const { ctrl, seen } = capturingController();
    await ctrl.listJobs(req(PLATFORM));
    expect(seen.hasCompanyId).toBe(false);
  });

  it('own companyId echoed back is byte-identical to omitted (own tenant)', async () => {
    const { ctrl, seen } = capturingController();
    await ctrl.listJobs(req(ADMIN), undefined, undefined, undefined, 'tenant-a');
    expect(seen.companyId).toBe('tenant-a');
  });
});
