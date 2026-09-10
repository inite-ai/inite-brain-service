import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import {
  SurrealService,
  retryOnUniqueViolation,
  isUniqueViolation,
  queryRows,
  queryFirst,
} from '../db/surreal.service';
import { withSpan } from '../common/tracing';
import { PROCESS_IDENTITY } from '../common/process-identity';
import type { JobType, JobStatus } from './job-run.service';

/** SurrealDB returns datetimes as a Date on 3.x and an ISO string via JSON. */
type RawDateTime = string | number | Date;

/** UPDATE … RETURN id ownership-guard rows — only the row COUNT is read. */
interface IdRow {
  id: unknown;
}

/** SELECT projection behind the /admin/leases active-claims snapshot. */
interface ActiveClaimRow {
  runId: string;
  jobType: string;
  claimedBy: string;
  claimedAt: RawDateTime;
  leaseUntil: RawDateTime;
  heartbeatAt: RawDateTime;
  attempts?: number;
}

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
   * Epoch of the worker_loop lease the claim was taken under (null when
   * no lease was involved). Every later write on the claim is fenced on
   * the row still carrying it.
   */
  claimEpoch: number | null;
  /**
   * W3C traceparent injected at enqueue time by the producer's span
   * context. Used by WorkerLoopService.dispatch to link the consumer
   * span as a child of the producer, so trace viewers stitch the
   * full publish→queue→process waterfall together.
   */
  traceparent?: string | undefined;
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
 * The actor identity (claimedBy) is PROCESS_IDENTITY — the same string
 * LeaderLeaseService presents, so an operator can correlate which pod
 * holds which claim against `/admin/leases`, and unique per process, so
 * the `claimedBy = $me` guard on every write names exactly one claimer.
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
  private readonly workerId: string = PROCESS_IDENTITY;

  constructor(@Optional() private readonly surreal?: SurrealService) {}

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
    ];
    const params: Record<string, unknown> = {
      runId,
      jobType: input.jobType,
      triggeredBy: input.triggeredBy,
    };
    // An unscheduled job takes visibleAfter from the schema DEFAULT
    // (time::now(), migration 0028) rather than this process's clock: the
    // claim filter is `visibleAfter <= time::now()`, so a row stamped from
    // a clock running ahead of the datastore's is unclaimable until the
    // difference elapses. Only a deliberately delayed job carries a
    // caller-supplied instant.
    if (input.visibleAfter !== undefined) {
      fields.push(`visibleAfter: type::datetime($visibleAfter)`);
      params.visibleAfter = input.visibleAfter.toISOString();
    }
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
              await db.query(`CREATE job_run CONTENT { ${fields.join(', ')} }`, params);
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
        const existing = await this.findByDedup(input.companyId, input.jobType, input.dedupKey);
        if (existing) return { runId: existing, created: false };
      }
      throw e;
    }
  }

  /**
   * Claim the oldest visible pending row for a (companyId, jobType): pick
   * the candidate with an index-backed read (job_run_claim_idx) outside
   * any transaction, then compare-and-set that ONE record pending→running.
   * A lost CAS (0 rows — another claimer got there first) moves on to the
   * next candidate, up to three per call. The previous shape ran the
   * SELECT and the UPDATE inside one transaction, which put the whole
   * table in the SSI read-set: two claimers aborted each other instead of
   * one of them winning. Returns null when nothing is claimable. `epoch`
   * is the worker_loop lease epoch the caller holds — stamped on the row,
   * it fences every later write on the claim.
   */
  async claimNext(input: {
    companyId: string;
    jobType: JobType;
    ttlSeconds: number;
    epoch?: number | null;
  }): Promise<JobClaim | null> {
    if (!this.surreal) return null;
    const claimEpoch = input.epoch ?? null;
    try {
      // JS-computed deadline + type::datetime: parses on SurrealDB 2.x
      // and 3.x alike, unlike the duration::from_* function path (see
      // LeaderLeaseService.acquire).
      const until = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
      return await retryOnUniqueViolation(() =>
        this.surreal!.withCompany(input.companyId, async (db) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = await queryFirst<{ id: unknown }>(
              db,
              // visibleAfter is PROJECTED, not just ordered on: SurrealDB 3.x
              // rejects an ORDER BY over an idiom missing from the selection
              // ("Missing order idiom `visibleAfter` in statement selection").
              `SELECT id, visibleAfter FROM job_run
                 WHERE status = 'pending'
                   AND visibleAfter <= time::now()
                   AND jobType = $jobType
                 ORDER BY visibleAfter ASC
                 LIMIT 1`,
              { jobType: input.jobType },
            );
            const rid = candidate ? String(candidate.id ?? '') : '';
            if (!rid) return null;
            const rows = await queryRows<Record<string, unknown>>(
              db,
              `UPDATE type::record($rid) SET
                  status = 'running',
                  claimedBy = $me,
                  claimedAt = time::now(),
                  leaseUntil = type::datetime($until),
                  heartbeatAt = time::now(),
                  attempts = (attempts OR 0) + 1,
                  claimEpoch = ${claimEpoch === null ? 'NONE' : '$epoch'}
                WHERE status = 'pending' AND visibleAfter <= time::now()
                RETURN AFTER`,
              {
                rid,
                me: this.workerId,
                until,
                ...(claimEpoch === null ? {} : { epoch: claimEpoch }),
              },
            );
            const row = rows[0];
            if (row) return this.toClaim(row, input.companyId, claimEpoch);
          }
          return null;
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
    claimEpoch: number | null;
    ttlSeconds: number;
  }): Promise<{ stillOwned: boolean; cancelRequested: boolean }> {
    if (!this.surreal) return { stillOwned: true, cancelRequested: false };
    try {
      const guard = this.ownerGuard(input.claimEpoch);
      return await this.surreal.withCompany(input.companyId, async (db) => {
        const rows = await queryRows<{ cancelRequested?: boolean }>(
          db,
          `UPDATE type::record($rid) SET
              leaseUntil = type::datetime($until),
              heartbeatAt = time::now()
            WHERE ${guard.where}
            RETURN cancelRequested`,
          {
            rid: input.recordId,
            until: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
            ...guard.params,
          },
        );
        if (rows.length === 0) {
          // Someone reaped us OR we never owned this row.
          return { stillOwned: false, cancelRequested: false };
        }
        return {
          stillOwned: true,
          cancelRequested: rows[0]?.cancelRequested === true,
        };
      });
    } catch (e) {
      // A thrown query is NOT evidence the claim is lost — that's what
      // the zero-rows branch above means. Treating a transient DB error
      // (network blip, pool timeout) as `stillOwned: false` aborted a
      // multi-minute job whose lease was still ≥2/3 valid; the work was
      // thrown away, the row waited out the real lease, and the reaper
      // requeued with attempts+1. Report still-owned: the lease clock
      // keeps running, and there is at least one more renew tick before
      // expiry to either succeed or genuinely lose ownership.
      this.logger.warn(
        `renew(${input.recordId}) failed transiently — assuming still owned: ${(e as Error).message}`,
      );
      return { stillOwned: true, cancelRequested: false };
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
    claimEpoch: number | null;
    result?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.surreal) return;
    try {
      const guard = this.ownerGuard(input.claimEpoch);
      await this.surreal.withCompany(input.companyId, async (db) => {
        const rows = await queryRows<IdRow>(
          db,
          // Ownership guard: only write the terminal status if WE still
          // own the running row. A worker that GC-paused past its lease,
          // got zombie-reaped, and had the row re-claimed by another pod
          // must NOT stomp the new owner's running claim — that would
          // corrupt status and double-count execution. 0 rows affected
          // ⇒ claim lost; skip silently (the dup-work cost is already
          // paid by the time we get here).
          `UPDATE type::record($rid) SET
              status = 'succeeded',
              finishedAt = time::now(),
              result = $result,
              claimedBy = NONE, leaseUntil = NONE, claimEpoch = NONE
            WHERE ${guard.where}
            RETURN id`,
          {
            rid: input.recordId,
            result: input.result ?? null,
            ...guard.params,
          },
        );
        if (rows.length === 0) {
          this.logger.warn(
            `complete(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
          );
        }
      });
    } catch (e) {
      this.logger.warn(`complete(${input.recordId}) failed: ${(e as Error).message}`);
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
    claimEpoch: number | null;
    attempts: number;
    error: { message: string; name?: string };
    requeue?: boolean;
    maxAttempts?: number;
    backoffBaseMs?: number;
    /** Persisted on the TERMINAL arm only (a handler's failed batch outcome). */
    result?: Record<string, unknown>;
  }): Promise<{ requeued: boolean }> {
    if (!this.surreal) return { requeued: false };
    const maxAttempts = input.maxAttempts ?? 3;
    const willRequeue = input.requeue !== false && input.attempts < maxAttempts;
    try {
      // Ownership guard on both arms: a zombie-reaped, re-claimed row
      // must not be requeued or terminal-failed out from under the new
      // owner. 0 rows affected ⇒ claim lost; report requeued: false.
      const guard = this.ownerGuard(input.claimEpoch);
      const affected = await this.surreal.withCompany(input.companyId, async (db) => {
        if (willRequeue) {
          const baseMs = input.backoffBaseMs ?? 30_000;
          // Exponential backoff with full jitter; cap at 1h.
          const backoffMs = Math.min(
            baseMs * Math.pow(2, input.attempts - 1) * (0.5 + Math.random() * 0.5),
            3_600_000,
          );
          const visibleAfter = new Date(Date.now() + backoffMs).toISOString();
          const rows = await queryRows<IdRow>(
            db,
            `UPDATE type::record($rid) SET
                  status = 'pending',
                  error = $err,
                  claimedBy = NONE, leaseUntil = NONE, claimEpoch = NONE,
                  visibleAfter = type::datetime($visibleAfter)
                WHERE ${guard.where}
                RETURN id`,
            {
              rid: input.recordId,
              err: input.error,
              visibleAfter,
              ...guard.params,
            },
          );
          return rows.length;
        }
        const rows = await queryRows<IdRow>(
          db,
          `UPDATE type::record($rid) SET
                status = 'failed',
                finishedAt = time::now(),
                error = $err,
                result = $result,
                claimedBy = NONE, leaseUntil = NONE, claimEpoch = NONE
              WHERE ${guard.where}
              RETURN id`,
          {
            rid: input.recordId,
            err: input.error,
            result: input.result ?? null,
            ...guard.params,
          },
        );
        return rows.length;
      });
      if (affected === 0) {
        this.logger.warn(
          `fail(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
        );
        return { requeued: false };
      }
      return { requeued: willRequeue };
    } catch (e) {
      this.logger.warn(`fail(${input.recordId}) failed: ${(e as Error).message}`);
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
    claimEpoch: number | null;
    result?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.surreal) return;
    try {
      const guard = this.ownerGuard(input.claimEpoch);
      await this.surreal.withCompany(input.companyId, async (db) => {
        const rows = await queryRows<IdRow>(
          db,
          // Ownership guard — same rationale as complete()/fail().
          `UPDATE type::record($rid) SET
              status = 'cancelled',
              finishedAt = time::now(),
              result = $result,
              claimedBy = NONE, leaseUntil = NONE, claimEpoch = NONE
            WHERE ${guard.where}
            RETURN id`,
          { rid: input.recordId, result: input.result ?? null, ...guard.params },
        );
        if (rows.length === 0) {
          this.logger.warn(
            `cancelled(${input.recordId}) no-op — claim no longer owned by ${this.workerId}; another worker re-claimed it`,
          );
        }
      });
    } catch (e) {
      this.logger.warn(`cancelled(${input.recordId}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * Hand a running claim back to the queue at once, without the failure
   * backoff: the pod is shutting down and the handler did not stop inside
   * the drain budget. attempts stays as claimed (a restart mid-job counts,
   * as it does for the reaper's ZombieReclaim). True iff the row was ours.
   */
  async release(input: {
    companyId: string;
    recordId: string;
    claimEpoch: number | null;
    reason: string;
  }): Promise<boolean> {
    if (!this.surreal) return false;
    try {
      const guard = this.ownerGuard(input.claimEpoch);
      const rows = await this.surreal.withCompany(input.companyId, (db) =>
        queryRows<IdRow>(
          db,
          `UPDATE type::record($rid) SET
              status = 'pending',
              error = $err,
              claimedBy = NONE, leaseUntil = NONE, claimEpoch = NONE,
              visibleAfter = time::now()
            WHERE ${guard.where}
            RETURN id`,
          {
            rid: input.recordId,
            err: { name: 'PodShutdown', message: input.reason },
            ...guard.params,
          },
        ),
      );
      if (rows.length === 0) {
        this.logger.warn(
          `release(${input.recordId}) no-op — claim no longer owned by ${this.workerId}`,
        );
      }
      return rows.length > 0;
    } catch (e) {
      this.logger.warn(`release(${input.recordId}) failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * WHERE clause naming a claim exactly: our identity, still running, and
   * the epoch it was taken under. A row claimed again — by another pod, or
   * by this pod in a later epoch — matches zero rows, so a stale writer
   * cannot touch it.
   */
  private ownerGuard(claimEpoch: number | null): {
    where: string;
    params: Record<string, unknown>;
  } {
    return claimEpoch === null
      ? {
          where: `claimedBy = $me AND status = 'running' AND claimEpoch IS NONE`,
          params: { me: this.workerId },
        }
      : {
          where: `claimedBy = $me AND status = 'running' AND claimEpoch = $epoch`,
          params: { me: this.workerId, epoch: claimEpoch },
        };
  }

  /** Shape one claimed `RETURN AFTER` row into a JobClaim. */
  private toClaim(
    row: Record<string, unknown>,
    companyId: string,
    claimEpoch: number | null,
  ): JobClaim | null {
    const recordId = String(row.id ?? '');
    const runId = String(row.runId ?? '');
    if (!recordId || !runId) return null;
    return {
      recordId,
      runId,
      jobType: row.jobType as JobType,
      companyId,
      attempts: Number(row.attempts ?? 1),
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      leaseUntil: new Date(row.leaseUntil as string).toISOString(),
      claimEpoch,
      traceparent: typeof row.traceparent === 'string' ? row.traceparent : undefined,
    } satisfies JobClaim;
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
  }): Promise<{ requeued: number; failed: number; errored?: string }> {
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
      // ERROR, not warn, and the reason is returned rather than swallowed.
      // A throw here means NOTHING was reaped: every job whose worker died
      // stays 'running' forever. Returning a bare {0, 0} made that total
      // failure indistinguishable from a clean sweep with nothing to do,
      // which is how a schema drift (migration 0134) ran for days at one
      // failure per 10s behind a green /health.
      const reason = (e as Error).message;
      this.logger.error(`reapZombies(${input.companyId}) failed: ${reason}`);
      return { requeued: 0, failed: 0, errored: reason };
    }
  }

  /**
   * Snapshot of currently-claimed rows across tenants — feeds the
   * /admin/leases panel. Cheap: indexed scan on (status, leaseUntil).
   */
  async listActiveClaims(companyIds: readonly string[]): Promise<
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
        const rows = await this.surreal.withCompany(companyId, (db) =>
          queryRows<ActiveClaimRow>(
            db,
            `SELECT runId, jobType, claimedBy, claimedAt, leaseUntil,
                    heartbeatAt, attempts
               FROM job_run
              WHERE status = 'running' AND claimedBy IS NOT NONE
              ORDER BY claimedAt DESC LIMIT 50`,
          ),
        );
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
        this.logger.warn(`listActiveClaims(${companyId}) failed: ${(e as Error).message}`);
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
        const row = await queryFirst<{ runId?: string }>(
          db,
          `SELECT runId FROM job_run
             WHERE jobType = $jobType AND dedupKey = $dk LIMIT 1`,
          { jobType, dk: dedupKey },
        );
        return row?.runId ?? null;
      });
    } catch {
      return null;
    }
  }
}

// Re-export status type for callers that only import JobClaimService.
export type { JobStatus };
