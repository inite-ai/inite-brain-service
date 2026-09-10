/**
 * /v1/admin/jobs/stream shows a job whichever replica runs it. Jobs
 * run on the lease holder, so the replica an admin's request lands on
 * usually executes none of them; the stream therefore polls job_run by
 * `updatedAt` (0140, stamped by the database on every write). "Another
 * replica" here is a direct database write: no JobRunService of this
 * process touches the row.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { JobStreamService } from '../src/admin/job-stream.service';
import type { JobRunRow } from '../src/jobs/job-run.service';

jest.setTimeout(120_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('/admin/jobs/stream across replicas', () => {
  let f: AppFixture;
  let surreal: SurrealService;

  beforeAll(async () => {
    f = await createApp();
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    await f.close();
  });

  async function otherReplicaStarts(runId: string): Promise<void> {
    await surreal.withCompany(f.companyId, (db) =>
      db.query(
        `CREATE job_run CONTENT {
           runId: $runId, jobType: 'dreams', status: 'running', triggeredBy: 'cron',
           startedAt: time::now(), progress: { processed: 0, total: 2 }, cancelRequested: false
         }`,
        { runId },
      ),
    );
  }

  async function otherReplicaFinishes(runId: string): Promise<void> {
    await surreal.withCompany(f.companyId, (db) =>
      db.query(
        `UPDATE job_run SET status = 'succeeded', finishedAt = time::now(),
                            progress = { processed: 2, total: 2 }
          WHERE runId = $runId`,
        { runId },
      ),
    );
  }

  it('emits a row another replica inserted, then its terminal update', async () => {
    const runId = `other-replica-${randomUUID()}`;
    const rows: JobRunRow[] = [];
    const sub = f.app
      .get(JobStreamService)
      .observe(f.companyId)
      .subscribe((r) => {
        if (r.runId === runId) rows.push(r);
      });
    await sleep(500); // cursor anchored at the database clock before the "other replica" writes

    await otherReplicaStarts(runId);
    await waitFor(() => rows.length >= 1, 'the inserted row');
    expect(rows[0]).toMatchObject({
      runId,
      jobType: 'dreams',
      status: 'running',
      companyId: f.companyId,
      progress: { processed: 0, total: 2 },
    });

    await otherReplicaFinishes(runId);
    await waitFor(() => rows.length >= 2, 'the terminal update');
    expect(rows[1]).toMatchObject({
      runId,
      status: 'succeeded',
      progress: { processed: 2, total: 2 },
    });
    expect(typeof rows[1]!.finishedAt).toBe('string');
    sub.unsubscribe();
  });

  it('serves the same over HTTP SSE, and stops on disconnect', async () => {
    const server = f.app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    const runId = `other-replica-${randomUUID()}`;
    let statusCode = 0;
    let body = '';
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/admin/jobs/stream',
        headers: { Authorization: `Bearer ${f.apiKey}`, Accept: 'text/event-stream' },
      },
      (res) => {
        statusCode = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
      },
    );
    await waitFor(() => statusCode !== 0, 'the SSE response head');
    expect(statusCode).toBe(200);
    await sleep(500);

    await otherReplicaStarts(runId);
    await waitFor(() => body.includes(runId), 'the SSE event');
    const event = body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as JobRunRow)
      .find((j) => j.runId === runId);
    expect(event).toMatchObject({ runId, status: 'running', companyId: f.companyId });
    req.destroy();
  });
});
