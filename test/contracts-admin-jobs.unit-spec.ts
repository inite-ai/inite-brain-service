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
 */
import { JobsListResponseSchema } from '../src/contracts/admin/jobs.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { JobRunService } from '../src/jobs/job-run.service';

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

describe('AdminJobsController.listJobs() — wire contract', () => {
  it('matches JobsListResponseSchema with mixed-status rows', async () => {
    const controller = makeController(makeJobs());
    const payload = await controller.listJobs();
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
    const parsed = JobsListResponseSchema.safeParse(await controller.listJobs());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.jobs).toHaveLength(0);
  });
});
