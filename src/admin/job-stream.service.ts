import { Injectable, Logger, Optional } from '@nestjs/common';
import { merge, type Observable } from 'rxjs';
import { concatMap, filter } from 'rxjs/operators';
import type { Surreal } from 'surrealdb';
import { LRUCache } from '../common/lru-cache';
import { SurrealService, queryRows } from '../db/surreal.service';
import { JobRunService, type JobRunRow } from '../jobs/job-run.service';
import { pollingObservable, stableStringify, type PollPage } from './db-poll-stream';

/** Cadence at which transitions made by other replicas reach a stream. */
export const JOB_STREAM_POLL_MS = 1_500;
/** Change markers read per tick; a larger burst continues on the next tick. */
const PAGE = 200;

type Stamp = string | number | Date;

/** The change marker of one job_run row — enough to tell a real transition
 *  from a heartbeat-only write without projecting payload/result. */
interface JobChangeRow {
  runId: string;
  status: string;
  updatedAt?: Stamp | null;
  finishedAt?: Stamp | null;
  progress?: Record<string, unknown> | null;
  cancelRequested?: boolean | null;
}

/**
 * Every job_run transition of one tenant, whichever replica performs it.
 * Same-process transitions arrive through JobRunService's Subject with no
 * delay; the rest are found by polling job_run for change markers whose
 * `updatedAt` (0140, stamped by the database on every write) reached the
 * last one seen, and read back through JobRunService.get so the streamed
 * shape stays the API's. A transition whose marker did not change is
 * dropped — that de-duplicates the two paths and hides heartbeat-only
 * writes without a second read.
 */
@Injectable()
export class JobStreamService {
  private readonly logger = new Logger(JobStreamService.name);

  constructor(
    private readonly jobs: JobRunService,
    @Optional() private readonly surreal?: SurrealService,
  ) {}

  observe(companyId: string): Observable<JobRunRow> {
    const seen = new LRUCache<string, string>(1_000);
    const fresh = (runId: string, sig: string): boolean => {
      if (seen.get(runId) === sig) return false;
      seen.set(runId, sig);
      return true;
    };
    const local = this.jobs
      .observe()
      .pipe(filter((j) => j.companyId === companyId && fresh(j.runId, signature(j))));
    const surreal = this.surreal;
    if (!surreal) return local;
    const polled = pollingObservable<string, Date>({
      intervalMs: JOB_STREAM_POLL_MS,
      initialCursor: () => surreal.withCompany(companyId, dbNow),
      poll: (since) => surreal.withCompany(companyId, (db) => changedSince(db, since, fresh)),
      onError: (e) => this.logger.warn(`job stream poll failed (${companyId}): ${e.message}`),
    });
    // concatMap, not mergeMap: the poll yields runIds in updatedAt order and
    // the stream must keep it. A row that vanished (or a read JobRunService
    // logged as failed) is dropped.
    const remote = polled.pipe(
      concatMap((runId) => this.jobs.get(runId, companyId)),
      filter((row): row is JobRunRow => row !== null),
    );
    return merge(local, remote);
  }
}

/** The database's clock, so the cursor never depends on this replica's. */
async function dbNow(db: Surreal): Promise<Date> {
  const [now] = await db.query<[Stamp]>(`RETURN time::now()`);
  return new Date(now);
}

/** The runIds whose change marker moved at or after `since`, and the cursor
 *  to resume from. `>=` (not `>`) because two writes can share a timestamp;
 *  the marker check collapses the re-read. */
async function changedSince(
  db: Surreal,
  since: Date,
  fresh: (runId: string, sig: string) => boolean,
): Promise<PollPage<string, Date>> {
  const rows = await queryRows<JobChangeRow>(
    db,
    `SELECT runId, status, updatedAt, finishedAt, progress, cancelRequested
       FROM job_run
      WHERE updatedAt >= $since
      ORDER BY updatedAt ASC LIMIT ${PAGE}`,
    { since },
  );
  let cursor = since;
  const out: string[] = [];
  for (const r of rows) {
    const at = r.updatedAt ? new Date(r.updatedAt) : since;
    if (at > cursor) cursor = at;
    if (fresh(r.runId, signature(r))) out.push(r.runId);
  }
  return { rows: out, cursor };
}

/** Stable encoding of the fields a stream consumer reacts to. Key order is
 *  normalised because `progress` is a free-form object whichever side
 *  serialised it. */
function signature(row: {
  status: string;
  finishedAt?: Stamp | null;
  progress?: Record<string, unknown> | null;
  cancelRequested?: boolean | null;
}): string {
  return stableStringify({
    status: row.status,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    progress: row.progress ?? null,
    cancelRequested: row.cancelRequested === true,
  });
}
