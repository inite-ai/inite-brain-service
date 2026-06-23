import { Injectable, Logger, Optional } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import {
  SurrealService,
  runTransaction,
  retryOnUniqueViolation,
  isUniqueViolation,
} from '../db/surreal.service';
import { withSpan } from '../common/tracing';
import type { JobType, JobStatus } from './job-run.service';

export interface JobClaim {
  /** Surreal record id, e.g. `job_run:abcd1234`. */
  recordId: string;
  /** Stable UUID written by enqueue() — surfaces in HTTP responses. */
  runId: string;
  jobType: JobType;
  companyId: string;
  attempts: number;
  /** Free-form payload set at enqueue. Handler reads it before dispatch. */
  payload: Record<string, unknown> | null;
  /** Lease deadline. Handler MUST renew before this passes. */
  leaseUntil: string;
  /**
   * W3C traceparent injected at enqueue time by the producer's span
   * context. Used by WorkerLoopService.dispatch to link the consumer
   * span as a child of the producer, so trace viewers stitch the
   * full publish→queue→process waterfall together.
   */
  traceparent?: string;
}

/**
 * JobClaimService — CAS primitives on the `job_run` table.
 *
 *   enqueue → pending row (idempotent via dedupKey).
 *   claimNext → atomic pending→running transition under OCC.
 *   renew → bump leaseUntil + heartbeatAt while handler runs.
 *   complete / fail → terminal state, optional requeue with backoff.
 *   reapZombies → recycle rows whose lease lapsed (worker crashed).
 *
 * The actor identity (claimedBy) is `hostname#pid` — same convention
 * as LeaderLeaseService so an operator can correlate which pod
 * holds which claim against `/admin/leases`.
 *
 * Per-tenant placement: the `job_run` table lives in each tenant's
 * `co_<companyId>` database (migration 0025). All methods take a
 * companyId; the WorkerLoopService iterates known tenants and calls
 * us once per tenant per poll cycle.
 *
 * Transient concurrency failures (CAS race, dedup race, OCC commit
 * abort) propagate as a null return — caller backs off and tries the
 * next tenant. Hard failures (DB down, malformed SQL) throw so the
 * loop can log and reschedule with backoff.
 */
@Injectable()
export class JobClaimService {
  private readonly logger = new Logger(JobClaimService.name);
  private readonly workerId: string;

  constructor(@Optional() private readonly surreal?: SurrealService) {
    this.workerId = `${hostname()}#${process.pid}`;
  }

  identity(): string {
    return this.workerId;
  }

  /**
   * Insert a new pending row. When `dedupKey` collides with an existing
   * row of the same jobType, returns the existing runId without
   * creating a duplicate — second cron tick during a leader transition
   * collapses cleanly.
   */
  async enqueue(input: {
    jobType: JobType;
    companyId: string;
    triggeredBy: 'cron' | 'manual' | 'startup';
    triggeredByActor?: string;
    dedupKey?: string;
    payload?: Record<string, unknown>;
    visibleAfter?: Date;
  }): Promise<{ runId: string; created: boolean }> {
    if (!this.surreal) {
      return { runId: randomUUID(), created: true };
    }
    const runId = randomUUID();
    const visibleAfterIso = (input.visibleAfter ?? new Date()).toISOString();
    // Capture the active W3C trace context (if any) so the consumer
    // span can attach as a child. Empty carrier outside an active
    // span — that's fine, the field stays unset and the consumer
    // starts a fresh root.
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier.traceparent;
    // SurrealDB v2 distinguishes NONE from NULL on `option<T>` fields
    // (especially indexed ones): passing JS null surfaces as
    // "Found NULL … expected option<T>". Build CONTENT incrementally
    // so option<> fields without a value are omitted from the literal
    // entirely, letting them default to NONE.
    const fields: string[] = [
      `runId: $runId`,
      `jobType: $jobType`,
      `status: 'pending'`,
      `triggeredBy: $triggeredBy`,
      `startedAt: time::now()`,
      `cancelRequested: false`,
      `attempts: 0`,
      `visibleAfter: type::datetime($visibleAfter)`,
    ];
    const params: Record<string, unknown> = {
      runId,
      jobType: input.jobType,
      triggeredBy: input.triggeredBy,
      visibleAfter: visibleAfterIso,
    };
    if (input.triggeredByActor !== undefined) {
      fields.push(`triggeredByActor: $actor`);
      params.actor = input.triggeredByActor;
    }
    if (input.payload !== undefined && input.payload !== null) {
      fields.push(`progress: $payload`, `payload: $payload`);
      params.payload = input.payload;
    }
    if (input.dedupKey !== undefined) {
      fields.push(`dedupKey: $dedupKey`);
      params.dedupKey = input.dedupKey;
    }
    if (traceparent) {
      fields.push(`traceparent: $traceparent`);
      params.traceparent = traceparent;
    }
    try {
      // OTel messaging.publish span — wraps the CREATE so the trace
      // viewer shows the producer side. Semantic conventions:
      // messaging.system = 'surrealdb', destination.name = jobType,
      // message.id = runId.
      const created = await withSpan(
        'jobs.enqueue',
        () =>
          retryOnUniqueViolation(() =>
            this.surreal!.withCompany(input.companyId, async (db) => {
              await db.query(
                `CREATE job_run CONTENT { ${fields.join(', ')} }`,
                params,
              );
              return true;
            }),
          ),
        {
          'messaging.system': 'surrealdb',
          'messaging.operation': 'publish',
          'messaging.destination.name': input.jobType,
          'messaging.destination.kind': 'queue',
          'messaging.message.id': runId,
          'job.companyId': input.companyId,
          'job.triggeredBy': input.triggeredBy,
          ...(input.dedupKey ? { 'job.dedupKey': input.dedupKey } : {}),
        },
      );
      return { runId, created };
    } catch (e) {
      // Dedup collision after retries exhausted — fetch the existing row
      // so the caller can observe (or attach to) the already-queued run.
      if (isUniqueViolation(e) && input.dedupKey) {
        const existing = await this.findByDedup(
          input.companyId,
          input.jobType,
          input.dedupKey,
        );
        if (existing) return { runId: existing, created: false };
      }
      throw e;
    }
  }

  /**
   * Find the oldest pending row for a (companyId, jobType) and CAS it
   * to running. Returns null when nothing is claimable (queue empty,
   * scheduled-future, or another pod grabbed it first).
   */
  async claimNext(input: {
    companyId: string;
    jobType: JobType;
    ttlSeconds: number;
  }): Promise<JobClaim | null> {
    if (!this.surreal) return null;
    try {
      return await retryOnUniqueViolation(() =>
        this.surreal!.withCompany(input.companyId, async (db) => {
          const claimed = await runTransaction<unknown>(db, (tx) => {
            tx.bind('jobType', input.jobType)
              .bind('me', this.workerId)
              .bind('ttl', input.ttlSeconds)
              .add(
                `LET $row = (SELECT * FROM job_run
                              WHERE jobType = $jobType
                                AND status = 'pending'
                                AND visibleAfter <= time::now()
                              ORDER BY visibleAfter ASC
                              LIMIT 1)[0]`,
              )
              .add(
                `IF $row IS NONE { RETURN NONE }
                 ELSE {
                   LET $updated = (UPDATE $row.id
                       SET status = 'running',
                           claimedBy = $me,
                           claimedAt = time::now(),
                           leaseUntil = time::now() + duration::from::secs($ttl),
                           heartbeatAt = time::now(),
                           attempts = ($row.attempts OR 0) + 1
                     WHERE status = 'pending'
                     RETURN AFTER)[0];
                   RETURN $updated;
                 }`,
              );
          });
          if (!claimed || typeof claimed !== 'object') return null;
          const row = claimed as Record<string, unknown>;
          const recordId = String(row.id ?? '');
          const runId = String(row.runId ?? '');
          if (!recordId || !runId) return null;
          return {
            recordId,
            runId,
            jobType: row.jobType as JobType,
            companyId: input.companyId,
            attempts: Number(row.attempts ?? 1),
            payload: (row.payload as Record<string, unknown> | null) ?? null,
            leaseUntil: new Date(row.leaseUntil as string).toISOString(),
            traceparent:
              typeof row.traceparent === 'string'
                ? row.traceparent
                : undefined,
          } satisfies JobClaim;
        }),
      );
    } catch (e) {
      this.logger.warn(
        `claimNext(${input.companyId}, ${input.jobType}) failed: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Push the lease forward. Caller must still own the claim — the
   * `claimedBy = $me` clause guards against renewing someone else's
   * row after a zombie reap reassigned ownership.
   */
  async renew(input: {
    companyId: string;
    recordId: string;
    ttlSeconds: number;
  }): Promise<{ stillOwned: boolean; cancelRequested: boolean }> {
    if (!this.surreal) return { stillOwned: true, cancelRequested: false };
    try {
      return await this.surreal.withCompany(input.companyId, async (db) => {
        const [rows] = (await db.query<any[]>(
          `UPDATE type::thing($rid) SET
              leaseUntil = time::now() + duration::from::secs($ttl),
              heartbeatAt = time::now()
            WHERE claimedBy = $me AND status = 'running'
            RETURN cancelRequested`,
          {
            rid: input.recordId,
            me: this.workerId,
            ttl: input.ttlSeconds,
          },
        )) as any[];
        const arr = (rows ?? []) as Array<{ cancelRequested?: boolean }>;
        if (arr.length === 0) {
          // Someone reaped us OR we never owned this row.
          return { stillOwned: false, cancelRequested: false };
        }
        return {
          stillOwned: true,
          cancelRequested: arr[0]?.cancelRequested === true,
        };
      });
    } catch (e) {
      this.logger.warn(
        `renew(${input.recordId}) failed: ${(e as Error).message}`,
      );
      return { stillOwned: false, cancelRequested: false };
    }
  }

  /**
   * Terminal success. Writes status='succeeded' and releases the lease
   * (claimedBy/leaseUntil=NONE) so the zombie-reaper leaves it alone. The
   * `dedupKey` STAYS on the row, so a re-enqueue with the same key collapses
   * onto this succeeded row (findByDedup matches any status) rather than
   * re-running — callers that want a fresh run must use a new dedupKey.
   */
  async complete(input: {
    companyId: string;
    recordId: string;
    result?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.surreal) return;
    try {
      await this.surreal.withCompany(input.companyId, async (db) => {
        const [rows] = (await db.query<any[]>(
          // Ownership guard: only write the terminal status if WE still
          // own the running row. A worker that GC-paused past its lease,
          // got zombie-reaped, and had the row re-claimed by another pod
          // must NOT stomp the new owner's running claim — that would
          // corrupt status and double-count execution. 0 rows affected
          // ⇒ claim lost; skip silently (the dup-work cost is already
          // paid by the time we get here).
          `UPDATE type::thing($rid) SET
              status = 'succeeded',
              finishedAt = time::now(),
              result = $result,
              claimedBy = NONE, leaseUntil = NONE
            WHERE claimedBy = $me AND status = 'running'
            RETURN id`,
          {
            rid: input.recordId,
            me: this.workerId,
            result: input.result ?? null,
          },
        )) as any[];
        if (((rows ?? []) as unknown[]).length === 0) {
          this.logger.warn(
            `complete(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
          );
        }
      });
    } catch (e) {
      this.logger.warn(
        `complete(${input.recordId}) failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Failure. When `requeue` is true and attempts < maxAttempts, the row
   * goes back to 'pending' with an exponential-backoff visibleAfter so
   * a transient failure (rate-limited LLM, surreal hiccup) can retry
   * naturally. Otherwise terminal-fail.
   */
  async fail(input: {
    companyId: string;
    recordId: string;
    attempts: number;
    error: { message: string; name?: string };
    requeue?: boolean;
    maxAttempts?: number;
    backoffBaseMs?: number;
  }): Promise<{ requeued: boolean }> {
    if (!this.surreal) return { requeued: false };
    const maxAttempts = input.maxAttempts ?? 3;
    const willRequeue =
      input.requeue !== false && input.attempts < maxAttempts;
    try {
      // Ownership guard on both arms: a zombie-reaped, re-claimed row
      // must not be requeued or terminal-failed out from under the new
      // owner. 0 rows affected ⇒ claim lost; report requeued: false.
      const affected = await this.surreal.withCompany(
        input.companyId,
        async (db) => {
          if (willRequeue) {
            const baseMs = input.backoffBaseMs ?? 30_000;
            // Exponential backoff with full jitter; cap at 1h.
            const backoffMs = Math.min(
              baseMs * Math.pow(2, input.attempts - 1) *
                (0.5 + Math.random() * 0.5),
              3_600_000,
            );
            const visibleAfter = new Date(
              Date.now() + backoffMs,
            ).toISOString();
            const [rows] = (await db.query<any[]>(
              `UPDATE type::thing($rid) SET
                  status = 'pending',
                  error = $err,
                  claimedBy = NONE, leaseUntil = NONE,
                  visibleAfter = type::datetime($visibleAfter)
                WHERE claimedBy = $me AND status = 'running'
                RETURN id`,
              {
                rid: input.recordId,
                me: this.workerId,
                err: input.error,
                visibleAfter,
              },
            )) as any[];
            return ((rows ?? []) as unknown[]).length;
          }
          const [rows] = (await db.query<any[]>(
            `UPDATE type::thing($rid) SET
                status = 'failed',
                finishedAt = time::now(),
                error = $err,
                claimedBy = NONE, leaseUntil = NONE
              WHERE claimedBy = $me AND status = 'running'
              RETURN id`,
            { rid: input.recordId, me: this.workerId, err: input.error },
          )) as any[];
          return ((rows ?? []) as unknown[]).length;
        },
      );
      if (affected === 0) {
        this.logger.warn(
          `fail(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
        );
        return { requeued: false };
      }
      return { requeued: willRequeue };
    } catch (e) {
      this.logger.warn(
        `fail(${input.recordId}) failed: ${(e as Error).message}`,
      );
      return { requeued: false };
    }
  }

  /**
   * Mark this row as cancelled — handler observed cancelRequested and
   * exited cleanly. Distinct from fail() because cancellation is not
   * an error and never requeues.
   */
  async cancelled(input: {
    companyId: string;
    recordId: string;
    result?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.surreal) return;
    try {
      await this.surreal.withCompany(input.companyId, async (db) => {
        const [rows] = (await db.query<any[]>(
          // Ownership guard — same rationale as complete()/fail().
          `UPDATE type::thing($rid) SET
              status = 'cancelled',
              finishedAt = time::now(),
              result = $result,
              claimedBy = NONE, leaseUntil = NONE
            WHERE claimedBy = $me AND status = 'running'
            RETURN id`,
          { rid: input.recordId, me: this.workerId, result: input.result ?? null },
        )) as any[];
        if (((rows ?? []) as unknown[]).length === 0) {
          this.logger.warn(
            `cancelled(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
          );
        }
      });
    } catch (e) {
      this.logger.warn(
        `cancelled(${input.recordId}) failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Find rows whose lease expired while their worker was claimed.
   * Below maxAttempts → requeue with backoff. At-or-above → terminal
   * fail with a synthetic 'zombie' error so the operator sees what
   * happened.
   *
   * Runs from LeaseManagerService cron. Caller iterates known tenants.
   */
  async reapZombies(input: {
    companyId: string;
    maxAttempts?: number;
    backoffBaseMs?: number;
  }): Promise<{ requeued: number; failed: number }> {
    if (!this.surreal) return { requeued: 0, failed: 0 };
    const maxAttempts = input.maxAttempts ?? 3;
    const baseMs = input.backoffBaseMs ?? 30_000;
    try {
      return await this.surreal.withCompany(input.companyId, async (db) => {
        // fn::reap_zombies (migration 0038) does the pre-select + split +
        // per-row backoff as two set-based UPDATEs inside one statement. Both
        // UPDATEs re-apply the status='running' AND leaseUntil<now guard in
        // their WHERE, so a row another reaper already flipped matches zero
        // rows — no read-then-write race between concurrent reapers, and no N
        // round-trips. One shared LIMIT 200 budget per call (not per branch).
        const [res] = (await db.query<[{ requeued: number; failed: number }]>(
          `RETURN fn::reap_zombies($max_attempts, $backoff_base_ms)`,
          { max_attempts: maxAttempts, backoff_base_ms: baseMs },
        )) as [{ requeued: number; failed: number }];
        return {
          requeued: Number(res?.requeued ?? 0),
          failed: Number(res?.failed ?? 0),
        };
      });
    } catch (e) {
      this.logger.warn(
        `reapZombies(${input.companyId}) failed: ${(e as Error).message}`,
      );
      return { requeued: 0, failed: 0 };
    }
  }

  /**
   * Snapshot of currently-claimed rows across tenants — feeds the
   * /admin/leases panel. Cheap: indexed scan on (status, leaseUntil).
   */
  async listActiveClaims(
    companyIds: readonly string[],
  ): Promise<
    Array<{
      runId: string;
      jobType: string;
      companyId: string;
      claimedBy: string;
      claimedAt: string;
      leaseUntil: string;
      heartbeatAt: string;
      attempts: number;
    }>
  > {
    if (!this.surreal) return [];
    const out: Array<{
      runId: string;
      jobType: string;
      companyId: string;
      claimedBy: string;
      claimedAt: string;
      leaseUntil: string;
      heartbeatAt: string;
      attempts: number;
    }> = [];
    for (const companyId of companyIds) {
      try {
        const rows = await this.surreal.withCompany(companyId, async (db) => {
          const [res] = (await db.query<any[]>(
            `SELECT runId, jobType, claimedBy, claimedAt, leaseUntil,
                    heartbeatAt, attempts
               FROM job_run
              WHERE status = 'running' AND claimedBy IS NOT NONE
              ORDER BY claimedAt DESC LIMIT 50`,
          )) as any[];
          return (res ?? []) as any[];
        });
        for (const r of rows) {
          out.push({
            runId: r.runId,
            jobType: r.jobType,
            companyId,
            claimedBy: r.claimedBy,
            claimedAt: new Date(r.claimedAt).toISOString(),
            leaseUntil: new Date(r.leaseUntil).toISOString(),
            heartbeatAt: new Date(r.heartbeatAt).toISOString(),
            attempts: Number(r.attempts ?? 0),
          });
        }
      } catch (e) {
        this.logger.warn(
          `listActiveClaims(${companyId}) failed: ${(e as Error).message}`,
        );
      }
    }
    return out;
  }

  private async findByDedup(
    companyId: string,
    jobType: JobType,
    dedupKey: string,
  ): Promise<string | null> {
    if (!this.surreal) return null;
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const [rows] = (await db.query<any[]>(
          `SELECT runId FROM job_run
             WHERE jobType = $jobType AND dedupKey = $dk LIMIT 1`,
          { jobType, dk: dedupKey },
        )) as any[];
        const arr = (rows ?? []) as Array<{ runId?: string }>;
        return arr[0]?.runId ?? null;
      });
    } catch {
      return null;
    }
  }
}

// Re-export status type for callers that only import JobClaimService.
export type { JobStatus };
