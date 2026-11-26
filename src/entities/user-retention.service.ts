import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { UserForgetService } from './user-forget.service';

/** The window family products run with (owner decision 2026-11-14): two years. */
export const FAMILY_RETENTION_DAYS = 730;
/** Users forgotten per job run; more waiting enqueue a continuation. */
export const RETENTION_USERS_PER_RUN = 25;
const DAY_MS = 24 * 60 * 60_000;
const RESUME_DELAY_MS = 60_000;

/** Minimal query surface: a scoped connection. */
export interface RetentionDb {
  query<T>(sql: string, params?: Record<string, unknown>): Promise<T>;
}

/** The tenant's rule, or null when retention is off (the default). */
export async function readRetentionDays(db: RetentionDb): Promise<number | null> {
  const [rows] = await db.query<[Array<{ userInactiveDays?: number | null }>]>(
    `SELECT userInactiveDays FROM type::record('retention_policy', 'users')`,
  );
  const days = (rows ?? [])[0]?.userInactiveDays;
  return typeof days === 'number' && days > 0 ? days : null;
}

/** Set (a number) or clear (null) the tenant's rule. */
async function writeRetentionDays(db: RetentionDb, days: number | null): Promise<void> {
  await db.query(
    `UPSERT type::record('retention_policy', 'users') SET userInactiveDays = $d, updatedAt = time::now()`,
    { d: days ?? undefined },
  );
}

/**
 * Every user's last write: the latest of their turns (episode), facts and
 * stored documents. A write is contact; a read made on a person's behalf
 * is not.
 */
export async function lastContactByUser(db: RetentionDb): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const legs = [
    `SELECT userId, time::max(recordedAt) AS last FROM episode WHERE userId IS NOT NONE GROUP BY userId`,
    `SELECT userId, time::max(recordedAt) AS last FROM knowledge_fact WHERE userId IS NOT NONE GROUP BY userId`,
    `SELECT userId, time::max(createdAt) AS last FROM source_document WHERE userId IS NOT NONE GROUP BY userId`,
  ];
  for (const sql of legs) {
    const [rows] = await db.query<[Array<{ userId?: string; last?: string | Date }>]>(sql);
    for (const r of rows ?? []) {
      if (!r.userId || !r.last) continue;
      const at = new Date(r.last);
      const prev = out.get(r.userId);
      if (!prev || at > prev) out.set(r.userId, at);
    }
  }
  return out;
}

/** Users whose last contact is older than `days`, oldest first. */
export function expiredUsers(last: Map<string, Date>, days: number, now = Date.now()): string[] {
  const cutoff = now - days * DAY_MS;
  return [...last.entries()]
    .filter(([, at]) => at.getTime() < cutoff)
    .sort((a, b) => a[1].getTime() - b[1].getTime())
    .map(([userId]) => userId);
}

export interface RetentionRun {
  /** null = retention is off for this tenant. */
  days: number | null;
  expired: number;
  forgotten: number;
  failed: number;
  remaining: number;
}

/**
 * Per-tenant retention: a person's memory is erased after `userInactiveDays`
 * without a write (owner decision 2026-11-14; FAMILY_RETENTION_DAYS for the
 * family products). OFF unless the tenant sets it (`retention_policy`,
 * migration 0201, PUT /v1/admin/retention): an existing tenant never
 * starts erasing because a release shipped.
 *
 * Runs as the background job `user_retention`, never on a request path: a
 * daily cron (04:41 UTC) enqueues one job per tenant, deduplicated per
 * day; the handler returns at once for a tenant with no rule. The erase is
 * the user forget itself (UserForgetService.forgetUser), so documents,
 * dead letters, episodes and every derived row go exactly as on a GDPR
 * request, and the forget's tombstone (0200) stops work still in flight
 * from writing the person back. At most RETENTION_USERS_PER_RUN users per
 * run; a longer list enqueues its own continuation.
 *
 * Cost: three GROUP BY passes over the tenant's user-scoped rows per day.
 * Whole-tenant, so the worker's, not a request's. Logs counts only.
 */
@Injectable()
export class UserRetentionService implements OnModuleInit {
  private readonly logger = new Logger(UserRetentionService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly forget: UserForgetService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register(
      'user_retention',
      async (ctx) => ({ ...(await this.runTenant(ctx.companyId)) }),
      {
        ttlSeconds: 600,
        maxAttempts: 3,
      },
    );
  }

  @Cron('41 4 * * *', { timeZone: 'UTC' })
  async enqueueAll(): Promise<{ enqueued: number }> {
    if (!this.claim) return { enqueued: 0 };
    const day = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of this.apiKeys.fanOutRoster()) {
      try {
        const { created } = await this.claim.enqueue({
          jobType: 'user_retention',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `user_retention_${day}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(`enqueue user_retention for ${companyId} failed: ${(e as Error).message}`);
      }
    }
    return { enqueued };
  }

  /** The tenant's window in days, or null when retention is off. */
  policy(companyId: string): Promise<number | null> {
    return this.surreal.withCompany(companyId, (db) => readRetentionDays(db));
  }

  /** Set (days) or clear (null) the tenant's window. */
  setPolicy(companyId: string, days: number | null): Promise<void> {
    return this.surreal.withCompany(companyId, (db) => writeRetentionDays(db, days));
  }

  async runTenant(companyId: string): Promise<RetentionRun> {
    const { days, expired } = await this.surreal.withCompany(companyId, async (db) => {
      const d = await readRetentionDays(db);
      if (d === null) return { days: null, expired: [] as string[] };
      return { days: d, expired: expiredUsers(await lastContactByUser(db), d) };
    });
    const run: RetentionRun = {
      days,
      expired: expired.length,
      forgotten: 0,
      failed: 0,
      remaining: 0,
    };
    if (days === null || expired.length === 0) return run;
    const batch = expired.slice(0, RETENTION_USERS_PER_RUN);
    for (const userId of batch) {
      try {
        await this.forget.forgetUser(companyId, userId);
        run.forgotten += 1;
      } catch (e) {
        run.failed += 1;
        this.logger.warn(`retention forget failed in ${companyId}: ${(e as Error).message}`);
      }
    }
    run.remaining = expired.length - batch.length;
    this.logger.log(
      `retention ${companyId}: window=${days}d expired=${run.expired} forgotten=${run.forgotten} failed=${run.failed} remaining=${run.remaining}`,
    );
    if (run.remaining > 0) await this.resume(companyId);
    return run;
  }

  private async resume(companyId: string): Promise<void> {
    if (!this.claim) return;
    const at = Math.ceil((Date.now() + RESUME_DELAY_MS) / RESUME_DELAY_MS) * RESUME_DELAY_MS;
    await this.claim.enqueue({
      jobType: 'user_retention',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `user_retention_resume_${at}`,
      visibleAfter: new Date(at),
    });
  }
}
