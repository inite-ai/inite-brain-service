/**
 * A job transition written while an admin stream is starting up must
 * still reach that stream.
 *
 * The stream anchors its cursor on the database clock, and reading that
 * clock goes through the tenant scope — so the replica serving the
 * stream pays the tenant's schema bootstrap whenever it is the first
 * caller through that tenant's door (a fresh pod after a deploy). The
 * bootstrap takes long enough for another replica to write a whole job
 * transition inside it; anchoring on a clock read AFTER the wait put
 * that write behind the cursor, where `updatedAt >= $since` never sees
 * it again.
 *
 * "Another replica" here is a second SurrealService in this process: its
 * own pool, its own schema cache, so it owns the tenant while the app's
 * service is still cold for it.
 */
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { JobStreamService } from '../src/admin/job-stream.service';
import type { JobRunRow } from '../src/jobs/job-run.service';

jest.setTimeout(180_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function dbNow(db: Surreal): Promise<Date> {
  const [now] = await db.query<[string]>(`RETURN time::now()`);
  return new Date(now);
}

describe('/admin/jobs/stream on a tenant this replica has never served', () => {
  let f: AppFixture;
  let appReplica: SurrealService;
  let otherReplica: SurrealService;

  beforeAll(async () => {
    f = await createApp();
    appReplica = f.app.get(SurrealService);
    otherReplica = new SurrealService(f.app.get(ConfigService));
    await otherReplica.onModuleInit();
  });

  afterAll(async () => {
    await otherReplica.onApplicationShutdown();
    await f.close();
  });

  it('delivers a transition written during the schema bootstrap', async () => {
    const companyId = `coldjob${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const neighbourId = `coldnb${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const runId = `cold-tenant-${randomUUID()}`;
    // The other replica owns the tenant: it provisions the schema and is
    // warm for it. The app's replica has still never seen it.
    await otherReplica.withCompany(companyId, (db) => db.query(`RETURN 1`));

    const rows: JobRunRow[] = [];
    // A pod's schema applies are globally serialised, so a replica meeting
    // two new tenants at once pays both before the second one's first
    // query runs. That is the ordinary shape of the window, and it makes
    // it wide enough to write into without racing.
    const neighbour = appReplica.withCompany(neighbourId, (db) => db.query(`RETURN 1`));
    const sub = f.app
      .get(JobStreamService)
      .observe(companyId)
      .subscribe((r) => {
        if (r.runId === runId) rows.push(r);
      });

    // No warm-up: the write races the stream's very first tick, which is
    // paying the bootstrap for this tenant.
    await otherReplica.withCompany(companyId, (db) =>
      db.query(
        `CREATE job_run CONTENT {
           runId: $runId, jobType: 'dreams', status: 'running', triggeredBy: 'cron',
           startedAt: time::now(), progress: { processed: 0, total: 2 }, cancelRequested: false
         }`,
        { runId },
      ),
    );
    // Resolves once the app replica's bootstrap for this tenant is done —
    // the moment its cursor used to be anchored at. Both timestamps come
    // off the database clock, so the comparison is skew-free.
    await neighbour;
    const bootstrapped = await appReplica.withCompany(companyId, dbNow);
    const [written] = await otherReplica.withCompany(companyId, (db) =>
      db.query<[Array<{ updatedAt: string }>]>(
        `SELECT updatedAt FROM job_run WHERE runId = $runId`,
        { runId },
      ),
    );
    const writtenAt = new Date(written![0]!.updatedAt);
    // Guards the test against passing vacuously: the write must really
    // have landed inside the bootstrap window.
    console.log(
      `[cold-tenant] write landed ${bootstrapped.getTime() - writtenAt.getTime()}ms before the ` +
        `bootstrap finished`,
    );
    expect(writtenAt.getTime()).toBeLessThan(bootstrapped.getTime());

    await waitFor(() => rows.length >= 1, 'the row written during the bootstrap');
    expect(rows[0]).toMatchObject({
      runId,
      jobType: 'dreams',
      status: 'running',
      companyId,
      progress: { processed: 0, total: 2 },
    });
    sub.unsubscribe();
  });
});
