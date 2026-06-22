/**
 * Wire-contract drift guard for GET /v1/admin/dreams/summary.
 */
import { DreamsSummaryResponseSchema } from '../src/contracts/admin/dreams-summary.schema';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import type { JobRunService } from '../src/jobs/job-run.service';

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
    undef, undef, undef, undef, undef, undef, undef, undef, undef,
    undef, undef, undef, undef, undef,
  );
}

describe('AdminJobsController.dreamsSummary() — wire contract', () => {
  it('matches DreamsSummaryResponseSchema', async () => {
    const parsed = DreamsSummaryResponseSchema.safeParse(
      await makeController().dreamsSummary(),
    );
    if (!parsed.success) {
      throw new Error(
        `dreams/summary drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
  });
});
