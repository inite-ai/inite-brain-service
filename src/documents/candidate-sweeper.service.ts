import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';

/**
 * Nightly hygiene for the Candidates layer — SurrealDB has no row TTL,
 * so a job owns the lifecycle tails:
 *
 *   * decided candidates (committed/merged/duplicate/rejected/expired)
 *     older than CANDIDATE_RETENTION_DAYS (30) are DELETED — their
 *     outcome lives on the committed fact's provenance;
 *   * pending candidates older than CANDIDATE_PENDING_TTL_DAYS (7) are
 *     marked 'expired' — a run that never got committed (crashed
 *     fan-out, abandoned async) must not look forever-pending;
 *   * documents past retainUntil lose their chunks (header + contentHash
 *     survive — same contract as the explicit purge endpoint).
 */
@Injectable()
export class CandidateSweeperService implements OnModuleInit {
  private readonly logger = new Logger(CandidateSweeperService.name);

  // Nightly job owner in the dreams-service mold: registration, cron-time
  // enqueue, and the sweep itself.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'candidate_sweeper',
      (ctx) => this.executeFromQueue(ctx),
      { ttlSeconds: 600, maxAttempts: 2 },
    );
  }

  /** 03:45 UTC — after compaction (03:17), before dreams (04:00). */
  @Cron('45 3 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<{ enqueued: number }> {
    if (!this.claim) return { enqueued: 0 };
    const tenants = this.apiKeys.knownCompanyIds();
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of tenants) {
      try {
        const { created } = await this.claim.enqueue({
          jobType: 'candidate_sweeper',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `candidate_sweeper_${today}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue candidate_sweeper for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    return { enqueued };
  }

  private async executeFromQueue(
    ctx: JobContext,
  ): Promise<Record<string, unknown>> {
    return this.sweepTenant(ctx.companyId);
  }

  async sweepTenant(companyId: string): Promise<Record<string, unknown>> {
    const retentionDays = envInt('CANDIDATE_RETENTION_DAYS', 30);
    const pendingTtlDays = envInt('CANDIDATE_PENDING_TTL_DAYS', 7);
    return this.surreal.withCompany(companyId, async (db) => {
      const expired = await this.countThen(db, {
        countWhere: `status = 'pending' AND createdAt < time::now() - duration::from::days($days)`,
        mutation: `UPDATE candidate SET status = 'expired',
             statusReason = 'sweeper_ttl', decidedAt = time::now()
           WHERE status = 'pending'
             AND createdAt < time::now() - duration::from::days($days)
           RETURN NONE`,
        params: { days: pendingTtlDays },
      });
      const deleted = await this.countThen(db, {
        countWhere: `status != 'pending' AND decidedAt != NONE AND decidedAt < time::now() - duration::from::days($days)`,
        mutation: `DELETE candidate
           WHERE status != 'pending'
             AND decidedAt != NONE
             AND decidedAt < time::now() - duration::from::days($days)`,
        params: { days: retentionDays },
      });
      // Document retention leg: expired retainUntil → chunks go, header +
      // contentHash stay (idempotency + committed provenance survive).
      const [purgedDocs] = await db.query<[any[]]>(
        `SELECT VALUE id FROM source_document
         WHERE retainUntil != NONE AND retainUntil < time::now()
           AND status != 'purged'`,
      );
      const purgeIds = ((purgedDocs as any[]) ?? []).map(String);
      for (const docId of purgeIds) {
        const tail = docId.slice(docId.indexOf(':') + 1);
        await db.query(
          `DELETE source_chunk WHERE docId = type::record('source_document', $doc);
           UPDATE type::record('source_document', $doc)
             SET status = 'purged', hasContent = false;`,
          { doc: tail },
        );
      }
      this.logger.log(
        `candidate sweep ${companyId}: expired=${expired} deleted=${deleted} purgedDocs=${purgeIds.length}`,
      );
      return { expired, deleted, purgedDocs: purgeIds.length };
    });
  }

  /** Count matching candidates, then run the mutation — honest job stats. */
  private async countThen(
    db: import('surrealdb').Surreal,
    p: {
      countWhere: string;
      mutation: string;
      params: Record<string, unknown>;
    },
  ): Promise<number> {
    const [rows] = await db.query<[any[]]>(
      `SELECT count() AS c FROM candidate WHERE ${p.countWhere} GROUP ALL`,
      p.params,
    );
    const count = ((rows as any[]) ?? [])[0]?.c ?? 0;
    if (count > 0) {
      await db.query(p.mutation, p.params);
    }
    return Number(count);
  }
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
