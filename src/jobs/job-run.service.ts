import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';

export type JobType =
  | 'dreams'
  | 'compaction'
  | 'calibration_refit'
  | 'source_trust_refit'
  | 'reindex_embeddings'
  | 'changefeed_drain';

/** Stable list of registered job types — used for iteration without
 *  duplicating the union elsewhere. */
export const JOB_TYPES: readonly JobType[] = [
  'dreams',
  'compaction',
  'calibration_refit',
  'source_trust_refit',
  'reindex_embeddings',
  'changefeed_drain',
];

export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface JobProgress {
  processed?: number;
  total?: number;
  currentTenant?: string;
  itemsEmitted?: number;
  partialStats?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface JobRunRow {
  runId: string;
  jobType: JobType;
  status: JobStatus;
  triggeredBy: 'cron' | 'manual' | 'startup';
  triggeredByActor?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  progress?: JobProgress | null;
  /** Immutable handler input — set once at enqueue, never modified. */
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: { message: string; name?: string; stack?: string } | null;
  cancelRequested: boolean;
  /** Phase J/K claim fields — populated when status='running'. */
  attempts?: number;
  claimedBy?: string | null;
  claimedAt?: string | null;
  leaseUntil?: string | null;
  heartbeatAt?: string | null;
  /** Pending-row scheduled visibility (delayed + retry backoff). */
  visibleAfter?: string | null;
  /** Synthetic tenant scope on the row — every row lives in one tenant DB. */
  companyId: string;
}

/**
 * JobRunService — generic projection of long-running operator jobs.
 *
 * Every long-running pipeline (dreams, compaction, calibration refit,
 * reindex, changefeed drain) declares its run here on start, updates
 * progress between batches, and commits a terminal status (succeeded/
 * failed/cancelled) on exit. The row lives in the same tenant DB as
 * the work it's doing — cross-tenant rollups happen in the admin
 * service.
 *
 * Cancel protocol: the JobRunService exposes `requestCancel(runId)`
 * which flips `cancelRequested=true`. Long-running jobs check
 * `await isCancelRequested(runId, companyId)` between batches and
 * exit gracefully (status='cancelled') when they observe the flag.
 *
 * SSE: the service exposes an RxJS Subject of progress + status
 * transitions so the admin UI can stream live updates without
 * polling.
 */
@Injectable()
export class JobRunService {
  private readonly logger = new Logger(JobRunService.name);
  private readonly stream = new Subject<JobRunRow>();
  /**
   * In-process cancel hints — Set of runIds whose cancel was requested
   * on THIS pod. Lets handlers running on the same pod that received
   * the cancel HTTP call see the request without a DB round-trip on
   * every isCancelRequested check.
   *
   * Cross-pod cancel does NOT live here. The persisted truth is
   * `job_run.cancelRequested=true`, written by requestCancel; the
   * worker loop polls it on every renew tick (ttl/3 cadence) and
   * propagates into the handler's AbortSignal. Pre-Phase-J this Set
   * was misnamed `cancelRequestsAcrossPods` — it never replicated.
   */
  private readonly inProcessCancelHints = new Set<string>();
  private readonly persistEnabled: boolean;

  constructor(
    @Optional() private readonly surreal?: SurrealService,
    @Optional() private readonly apiKeys?: ApiKeyService,
    @Optional() config?: ConfigService,
  ) {
    this.persistEnabled =
      (config?.get<string>('JOB_RUN_PERSIST', '1') ?? '1') !== '0' &&
      !!this.surreal;
  }

  /**
   * Allocate a new job_run row. Returns the runId so the caller can
   * thread it through subsequent updates. The row starts in 'running'
   * status — the convention is "we don't write the row until we've
   * started actually working" to avoid 'pending' rows leaking when
   * the process crashes between allocation and execution.
   */
  async start(input: {
    jobType: JobType;
    companyId: string;
    triggeredBy: 'cron' | 'manual' | 'startup';
    triggeredByActor?: string;
    initialProgress?: JobProgress;
  }): Promise<JobRunRow> {
    const runId = randomUUID();
    const row: JobRunRow = {
      runId,
      jobType: input.jobType,
      status: 'running',
      triggeredBy: input.triggeredBy,
      triggeredByActor: input.triggeredByActor ?? null,
      startedAt: new Date().toISOString(),
      progress: input.initialProgress ?? null,
      cancelRequested: false,
      companyId: input.companyId,
    };
    if (this.persistEnabled && this.surreal) {
      try {
        await this.surreal.withCompany(input.companyId, async (db) => {
          await db.query(
            `CREATE job_run CONTENT {
               runId: $runId, jobType: $jobType, status: $status,
               triggeredBy: $triggeredBy, triggeredByActor: $triggeredByActor,
               startedAt: $startedAt, progress: $progress,
               cancelRequested: false
             }`,
            {
              runId,
              jobType: row.jobType,
              status: row.status,
              triggeredBy: row.triggeredBy,
              triggeredByActor: row.triggeredByActor,
              startedAt: row.startedAt,
              progress: row.progress,
            },
          );
        });
      } catch (e) {
        this.logger.warn(
          `job_run persist start failed (${row.jobType} ${runId}): ${(e as Error).message}`,
        );
      }
    }
    this.stream.next(row);
    return row;
  }

  async updateProgress(row: JobRunRow, progress: JobProgress): Promise<void> {
    row.progress = { ...(row.progress ?? {}), ...progress };
    if (this.persistEnabled && this.surreal) {
      try {
        await this.surreal.withCompany(row.companyId, async (db) => {
          await db.query(
            `UPDATE job_run SET progress = $progress WHERE runId = $runId`,
            { progress: row.progress, runId: row.runId },
          );
        });
      } catch (e) {
        this.logger.warn(
          `job_run progress write failed (${row.runId}): ${(e as Error).message}`,
        );
      }
    }
    this.stream.next(row);
  }

  async finish(
    row: JobRunRow,
    outcome: {
      status: 'succeeded' | 'failed' | 'cancelled';
      result?: Record<string, unknown>;
      error?: { message: string; name?: string };
    },
  ): Promise<void> {
    row.status = outcome.status;
    row.finishedAt = new Date().toISOString();
    if (outcome.result !== undefined) row.result = outcome.result;
    if (outcome.error !== undefined) row.error = outcome.error;
    if (this.persistEnabled && this.surreal) {
      try {
        await this.surreal.withCompany(row.companyId, async (db) => {
          await db.query(
            `UPDATE job_run SET status = $status, finishedAt = $finishedAt,
                                result = $result, error = $error
              WHERE runId = $runId`,
            {
              status: row.status,
              finishedAt: row.finishedAt,
              result: row.result ?? null,
              error: row.error ?? null,
              runId: row.runId,
            },
          );
        });
      } catch (e) {
        this.logger.warn(
          `job_run finish write failed (${row.runId}): ${(e as Error).message}`,
        );
      }
    }
    this.inProcessCancelHints.delete(row.runId);
    this.stream.next(row);
  }

  /**
   * Operator-requested cancellation.
   *
   *   pending rows → terminal-cancel directly (the work hasn't started
   *                  yet, so there's nothing to observe the flag).
   *   running rows → set cancelRequested=true; WorkerLoopService.renew
   *                  reads it on next tick and aborts the handler.
   *                  Pre-queue inline handlers still poll via
   *                  isCancelRequested between batches.
   *
   * Returns whether the row was found AND now in a cancel-respecting
   * state (cancelled or running-with-flag-set). Already-terminal rows
   * (succeeded/failed/cancelled) return false — caller's HTTP gets a
   * "no longer cancellable" hint.
   */
  async requestCancel(runId: string, companyId: string): Promise<boolean> {
    this.inProcessCancelHints.add(runId);
    if (!this.persistEnabled || !this.surreal) return true;
    try {
      const updated = await this.surreal.withCompany(companyId, async (db) => {
        // Atomic: take pending rows straight to cancelled, flag running
        // rows. RETURN status so we can tell the caller which path fired.
        const res = (await db.query<any[]>(
          `UPDATE job_run SET
              cancelRequested = true,
              status = IF status = 'pending' THEN 'cancelled' ELSE status END,
              finishedAt = IF status = 'pending' THEN time::now() ELSE finishedAt END,
              claimedBy = IF status = 'pending' THEN NONE ELSE claimedBy END,
              leaseUntil = IF status = 'pending' THEN NONE ELSE leaseUntil END
            WHERE runId = $runId
              AND status IN ['pending', 'running']
            RETURN status`,
          { runId },
        )) as any[];
        const rows = (res[0] ?? []) as Array<{ status?: string }>;
        return rows.length > 0;
      });
      return updated;
    } catch (e) {
      this.logger.warn(
        `job_run cancel write failed (${runId}): ${(e as Error).message}`,
      );
      return false;
    }
  }

  async isCancelRequested(
    runId: string,
    companyId: string,
  ): Promise<boolean> {
    if (this.inProcessCancelHints.has(runId)) return true;
    if (!this.persistEnabled || !this.surreal) return false;
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const res = (await db.query<any[]>(
          `SELECT cancelRequested FROM job_run
            WHERE runId = $runId AND companyId = $companyId LIMIT 1`,
          { runId, companyId },
        )) as any[];
        const rows = (res[0] ?? []) as Array<{ cancelRequested?: boolean }>;
        return rows[0]?.cancelRequested === true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Cross-tenant list — admin overview. Filters by jobType / status /
   * since are optional. Always sorts newest first; caps at `limit`
   * per tenant before merging so a single noisy tenant can't crowd
   * out the rest.
   */
  async list(filter: {
    jobType?: JobType;
    status?: JobStatus;
    since?: string;
    limit?: number;
    companyId?: string;
  }): Promise<JobRunRow[]> {
    if (!this.persistEnabled || !this.surreal || !this.apiKeys) return [];
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const tenants = filter.companyId
      ? [filter.companyId]
      : this.apiKeys.knownCompanyIds();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.jobType) {
      where.push('jobType = $jobType');
      params.jobType = filter.jobType;
    }
    if (filter.status) {
      where.push('status = $status');
      params.status = filter.status;
    }
    if (filter.since) {
      where.push('startedAt >= type::datetime($since)');
      params.since = filter.since;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const out: JobRunRow[] = [];
    for (const companyId of tenants) {
      try {
        const rows = await this.surreal.withCompany(companyId, async (db) => {
          const res = (await db.query<any[]>(
            `SELECT runId, jobType, status, triggeredBy, triggeredByActor,
                    startedAt, finishedAt, progress, payload, result, error,
                    cancelRequested, attempts, claimedBy, claimedAt,
                    leaseUntil, heartbeatAt, visibleAfter
               FROM job_run ${whereSql}
              ORDER BY startedAt DESC LIMIT ${limit}`,
            params,
          )) as any[];
          return (res[0] ?? []) as any[];
        });
        for (const r of rows) {
          out.push({
            runId: r.runId,
            jobType: r.jobType,
            status: r.status,
            triggeredBy: r.triggeredBy ?? 'cron',
            triggeredByActor: r.triggeredByActor ?? null,
            startedAt: new Date(r.startedAt).toISOString(),
            finishedAt: r.finishedAt
              ? new Date(r.finishedAt).toISOString()
              : null,
            progress: r.progress ?? null,
            payload: r.payload ?? null,
            result: r.result ?? null,
            error: r.error ?? null,
            cancelRequested: r.cancelRequested === true,
            attempts: typeof r.attempts === 'number' ? r.attempts : undefined,
            claimedBy: r.claimedBy ?? null,
            claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null,
            leaseUntil: r.leaseUntil
              ? new Date(r.leaseUntil).toISOString()
              : null,
            heartbeatAt: r.heartbeatAt
              ? new Date(r.heartbeatAt).toISOString()
              : null,
            visibleAfter: r.visibleAfter
              ? new Date(r.visibleAfter).toISOString()
              : null,
            companyId,
          });
        }
      } catch (e) {
        this.logger.warn(
          `job_run list failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out.slice(0, limit);
  }

  async get(runId: string, companyId: string): Promise<JobRunRow | null> {
    if (!this.persistEnabled || !this.surreal) return null;
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const res = (await db.query<any[]>(
          `SELECT runId, jobType, status, triggeredBy, triggeredByActor,
                  startedAt, finishedAt, progress, payload, result, error,
                  cancelRequested, attempts, claimedBy, claimedAt,
                  leaseUntil, heartbeatAt, visibleAfter
             FROM job_run WHERE runId = $runId LIMIT 1`,
          { runId },
        )) as any[];
        const r = ((res[0] ?? []) as any[])[0];
        if (!r) return null;
        return {
          runId: r.runId,
          jobType: r.jobType,
          status: r.status,
          triggeredBy: r.triggeredBy ?? 'cron',
          triggeredByActor: r.triggeredByActor ?? null,
          startedAt: new Date(r.startedAt).toISOString(),
          finishedAt: r.finishedAt
            ? new Date(r.finishedAt).toISOString()
            : null,
          progress: r.progress ?? null,
          payload: r.payload ?? null,
          result: r.result ?? null,
          error: r.error ?? null,
          cancelRequested: r.cancelRequested === true,
          attempts: typeof r.attempts === 'number' ? r.attempts : undefined,
          claimedBy: r.claimedBy ?? null,
          claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null,
          leaseUntil: r.leaseUntil
            ? new Date(r.leaseUntil).toISOString()
            : null,
          heartbeatAt: r.heartbeatAt
            ? new Date(r.heartbeatAt).toISOString()
            : null,
          visibleAfter: r.visibleAfter
            ? new Date(r.visibleAfter).toISOString()
            : null,
          companyId,
        } as JobRunRow;
      });
    } catch (e) {
      this.logger.warn(`job_run get failed (${runId}): ${(e as Error).message}`);
      return null;
    }
  }

  observe() {
    return this.stream.asObservable();
  }
}
