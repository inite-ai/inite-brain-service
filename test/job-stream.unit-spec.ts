/**
 * JobStreamService — /admin/jobs/stream must show a job whichever
 * replica runs it. Local transitions come from JobRunService's Subject
 * at once; other replicas' transitions are found by polling job_run
 * change markers by updatedAt and read back through JobRunService.get;
 * a transition seen on both paths is emitted once, and a write that
 * changed no marker costs no read at all.
 */
import { Subject } from 'rxjs';
import { JOB_STREAM_POLL_MS, JobStreamService } from '../src/admin/job-stream.service';
import type { JobRunRow, JobRunService } from '../src/jobs/job-run.service';
import type { SurrealService } from '../src/db/surreal.service';

const T0 = new Date('2026-09-10T00:00:00.000Z');

interface DbRow {
  runId: string;
  status: string;
  updatedAt: Date;
  finishedAt?: Date | null;
  progress?: Record<string, unknown> | null;
  cancelRequested?: boolean;
  heartbeatAt?: Date | null;
}

function harness(opts: { withDb?: boolean } = {}) {
  const local = new Subject<JobRunRow>();
  const state = { rows: [] as DbRow[], sinces: [] as Date[], tenants: [] as string[] };
  const reads: string[] = [];
  const jobs = {
    observe: () => local.asObservable(),
    // Stands in for JobRunService's own projection + mapper.
    get: async (runId: string, companyId: string): Promise<JobRunRow | null> => {
      reads.push(runId);
      const row = state.rows.find((r) => r.runId === runId);
      return row ? mapped(row, companyId) : null;
    },
  } as unknown as JobRunService;
  const surreal = {
    withCompany: async (companyId: string, fn: (db: any) => Promise<any>) => {
      state.tenants.push(companyId);
      return fn({
        query: async (sql: string, vars?: { since: Date }) => {
          if (sql.startsWith('RETURN time::now()')) return [T0];
          state.sinces.push(vars!.since);
          const rows = state.rows
            .filter((r) => r.updatedAt >= vars!.since)
            .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
          return [rows];
        },
      });
    },
  } as unknown as SurrealService;
  const svc = new JobStreamService(jobs, opts.withDb === false ? undefined : surreal);
  const seen: JobRunRow[] = [];
  const sub = svc.observe('co_a').subscribe((r) => seen.push(r));
  return { local, state, seen, sub, reads };
}

function localRow(over: Partial<JobRunRow> = {}): JobRunRow {
  return {
    runId: 'run-1',
    jobType: 'dreams',
    status: 'running',
    triggeredBy: 'cron',
    triggeredByActor: null,
    startedAt: T0.toISOString(),
    finishedAt: null,
    progress: { processed: 1, total: 3 },
    cancelRequested: false,
    companyId: 'co_a',
    ...over,
  };
}

function dbRow(over: Partial<DbRow> = {}): DbRow {
  return {
    runId: 'run-2',
    status: 'running',
    updatedAt: new Date(T0.getTime() + 500),
    progress: { total: 3, processed: 1 },
    cancelRequested: false,
    ...over,
  };
}

function mapped(r: DbRow, companyId: string): JobRunRow {
  return {
    runId: r.runId,
    jobType: 'compaction',
    status: r.status as JobRunRow['status'],
    triggeredBy: 'cron',
    triggeredByActor: null,
    startedAt: T0.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    progress: r.progress ?? null,
    cancelRequested: r.cancelRequested === true,
    companyId,
  };
}

describe('JobStreamService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits a same-process transition at once, with no database round-trip', () => {
    const h = harness();
    h.local.next(localRow());
    expect(h.seen).toHaveLength(1);
    expect(h.state.sinces).toHaveLength(0);
    expect(h.reads).toEqual([]);
    h.sub.unsubscribe();
  });

  it('emits a row written by another replica after one poll tick, in the API shape', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(0); // cursor anchored at the DB clock
    h.state.rows.push(dbRow());
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({
      runId: 'run-2',
      status: 'running',
      startedAt: T0.toISOString(),
      companyId: 'co_a',
      progress: { total: 3, processed: 1 },
    });
    expect(h.reads).toEqual(['run-2']);
    expect(h.state.tenants[0]).toBe('co_a');
    h.sub.unsubscribe();
  });

  it('advances the cursor to the newest updatedAt it has seen', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(0);
    const at = new Date(T0.getTime() + 700);
    h.state.rows.push(dbRow({ updatedAt: at }));
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS * 2);
    expect(h.state.sinces[0]).toEqual(T0);
    expect(h.state.sinces[2]).toEqual(at);
    h.sub.unsubscribe();
  });

  it('emits a transition once when it arrives locally and then from the database', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(0);
    h.local.next(localRow({ runId: 'run-1', progress: { processed: 1, total: 3 } }));
    h.state.rows.push(dbRow({ runId: 'run-1', progress: { total: 3, processed: 1 } }));
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen).toHaveLength(1);
    expect(h.reads).toEqual([]); // the marker matched what the Subject already delivered
    h.sub.unsubscribe();
  });

  it('collapses heartbeat-only writes but emits a progress change', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(0);
    const row = dbRow();
    h.state.rows.push(row);
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    row.heartbeatAt = new Date(T0.getTime() + 900);
    row.updatedAt = new Date(T0.getTime() + 900);
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen).toHaveLength(1);
    expect(h.reads).toEqual(['run-2']);
    row.progress = { total: 3, processed: 2 };
    row.updatedAt = new Date(T0.getTime() + 1200);
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen).toHaveLength(2);
    expect(h.seen[1]!.progress).toEqual({ total: 3, processed: 2 });
    h.sub.unsubscribe();
  });

  it('emits the terminal transition of a job it already streamed as running', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(0);
    const row = dbRow();
    h.state.rows.push(row);
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    row.status = 'succeeded';
    row.finishedAt = new Date(T0.getTime() + 2_000);
    row.updatedAt = row.finishedAt;
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen.map((r) => r.status)).toEqual(['running', 'succeeded']);
    expect(h.seen[1]!.finishedAt).toBe(row.finishedAt.toISOString());
    h.sub.unsubscribe();
  });

  it('scopes local transitions to the caller tenant', () => {
    const h = harness();
    h.local.next(localRow({ companyId: 'co_b' }));
    expect(h.seen).toHaveLength(0);
    h.sub.unsubscribe();
  });

  it('stops polling when the client disconnects', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    const before = h.state.sinces.length;
    h.sub.unsubscribe();
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS * 3);
    expect(h.state.sinces).toHaveLength(before);
  });

  it('is the local stream alone when no database is wired (unit fixtures)', async () => {
    const h = harness({ withDb: false });
    h.local.next(localRow());
    await jest.advanceTimersByTimeAsync(JOB_STREAM_POLL_MS);
    expect(h.seen).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    h.sub.unsubscribe();
  });
});
