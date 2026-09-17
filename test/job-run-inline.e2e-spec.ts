/**
 * JobRunService's inline lifecycle (start → updateProgress → finish →
 * get) against a REAL SurrealDB. Pinned because on 3.x the CREATE and the
 * finish UPDATE failed on every call — an ISO string handed to a
 * `datetime` field, a JS null to an `option<object>` — and the failure
 * was swallowed into a warn, so every inline run (dreams, calibration
 * refit, vector corpus, the agent protocol) was invisible to the cockpit
 * and `get()` answered null. A row must exist after start and carry its
 * terminal state after finish.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { JobRunService } from '../src/jobs/job-run.service';

const COMPANY = 'co_job_run_inline_e2e';

describe('job_run inline lifecycle (e2e)', () => {
  let f: AppFixture;
  let jobs: JobRunService;

  beforeAll(async () => {
    process.env.WORKER_LOOP_ENABLED = '0';
    f = await createApp({ companyId: COMPANY });
    jobs = f.app.get(JobRunService);
  }, 120_000);

  afterAll(async () => {
    if (f) await f.close();
  });

  it('start persists the row (with and without progress / actor); progress and finish land', async () => {
    const bare = await jobs.start({ jobType: 'dreams', companyId: COMPANY, triggeredBy: 'manual' });
    const bareRow = await jobs.get(bare.runId, COMPANY);
    expect(bareRow).toMatchObject({ runId: bare.runId, jobType: 'dreams', status: 'running', triggeredByActor: null });
    expect(bareRow?.progress ?? null).toBeNull();

    const rich = await jobs.start({
      jobType: 'source_sync',
      companyId: COMPANY,
      triggeredBy: 'manual',
      triggeredByActor: 'agent:laptop',
      initialProgress: { connectionId: 'source_connection:x', counters: { seen: 0 }, checkpoint: null },
    });
    expect(await jobs.get(rich.runId, COMPANY)).toMatchObject({
      triggeredByActor: 'agent:laptop',
      progress: { connectionId: 'source_connection:x', counters: { seen: 0 } },
    });

    await jobs.updateProgress(rich, { counters: { seen: 3 } });
    expect((await jobs.get(rich.runId, COMPANY))?.progress).toMatchObject({ counters: { seen: 3 } });

    await jobs.finish(rich, { status: 'succeeded', result: { ingested: 3 } });
    const done = await jobs.get(rich.runId, COMPANY);
    expect(done).toMatchObject({ status: 'succeeded', result: { ingested: 3 }, error: null });
    expect(done?.finishedAt).toMatch(/^\d{4}-/);

    await jobs.finish(bare, { status: 'failed', error: { message: 'boom' } });
    expect(await jobs.get(bare.runId, COMPANY)).toMatchObject({ status: 'failed', error: { message: 'boom' } });

    // The admin list sees both, newest first.
    const listed = await f.http.get('/v1/admin/jobs').set({ Authorization: `Bearer ${f.apiKey}` });
    const ids = listed.body.jobs.map((j: { runId: string }) => j.runId);
    expect(ids).toEqual(expect.arrayContaining([bare.runId, rich.runId]));
  });
});
