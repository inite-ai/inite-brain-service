import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';

export interface CompactionStats {
  companyId: string;
  factsCompacted: number;
  bytesFreed: number;
}

/**
 * CompactionService — daily retention pass per spec.
 *
 * Spec requires hot retention of 90d on raw facts; older facts must be
 * compacted into summary facts and lose their large fields (embedding,
 * raw text). Compaction here is non-LLM — we mark the row `status = 'compacted'`
 * and drop the embedding to free vector storage. A future revision can
 * roll up multiple compacted rows per (entity, predicate) into a single
 * summary fact via the LLM, with `derivedFrom` linking to the originals.
 *
 * Why per-tenant fan-out: the schema lives in NS=brain DB=co_<companyId>.
 * We discover tenants from ApiKeyService — anything with a registered key
 * is a tenant. JWKS-issued tenants would need a live registry of issued
 * subjects to be covered here; that's a follow-up once auth-service exposes
 * a tenant directory.
 *
 * Idempotent: a compacted row stays compacted; re-running the job on the
 * same window finds zero work.
 */
@Injectable()
export class CompactionService {
  private readonly logger = new Logger(CompactionService.name);
  private readonly hotRetentionDays: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
    private readonly metrics?: MetricsService,
  ) {
    this.hotRetentionDays = parseInt(
      config.get<string>('COMPACTION_HOT_RETENTION_DAYS', '90'),
      10,
    );
    if (!Number.isFinite(this.hotRetentionDays) || this.hotRetentionDays < 1) {
      throw new Error('COMPACTION_HOT_RETENTION_DAYS must be a positive integer');
    }
  }

  /** Cron entry — daily at 03:17 UTC, off-peak for most regions. */
  @Cron('17 3 * * *', { timeZone: 'UTC' })
  async runDaily(): Promise<CompactionStats[]> {
    return this.compactAll();
  }

  /**
   * Compact every known tenant. Errors per-tenant are logged; one bad
   * tenant must not stop the rest from getting compacted.
   */
  async compactAll(): Promise<CompactionStats[]> {
    const tenants = this.apiKeys.knownCompanyIds();
    this.logger.log(`Compaction starting — ${tenants.length} tenant(s)`);
    const results: CompactionStats[] = [];
    for (const companyId of tenants) {
      try {
        const stats = await this.compactCompany(companyId);
        results.push(stats);
      } catch (e) {
        this.logger.error(
          `Compaction failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    const total = results.reduce((acc, r) => acc + r.factsCompacted, 0);
    this.logger.log(
      `Compaction done — ${total} fact(s) across ${results.length} tenant(s)`,
    );
    return results;
  }

  /**
   * Compact one tenant. Targets `knowledge_fact` rows with
   *   - validUntil older than the retention window, OR
   *   - retractedAt older than the retention window
   * and that are still carrying the heavy fields (embedding != NONE).
   *
   * For each match: set status='compacted', clear embedding, keep the row
   * (timeline integrity). Returns count + bytes-freed estimate.
   */
  async compactCompany(companyId: string): Promise<CompactionStats> {
    const cutoff = new Date(
      Date.now() - this.hotRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return this.surreal.withCompany(companyId, async (db) => {
      // Step 1: count matches before mutation so the stats are accurate.
      const [countRows] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() AS count FROM knowledge_fact
           WHERE status != 'compacted'
             AND embedding != NONE
             AND ((validUntil != NONE AND validUntil < d$cutoff)
                  OR (retractedAt != NONE AND retractedAt < d$cutoff))
           GROUP ALL`,
        { cutoff },
      );
      const factsCompacted = Number(
        ((countRows ?? []) as Array<{ count: number }>)[0]?.count ?? 0,
      );

      if (factsCompacted === 0) {
        return { companyId, factsCompacted: 0, bytesFreed: 0 };
      }

      await db.query(
        `UPDATE knowledge_fact
           SET status = 'compacted', embedding = NONE
           WHERE status != 'compacted'
             AND embedding != NONE
             AND ((validUntil != NONE AND validUntil < d$cutoff)
                  OR (retractedAt != NONE AND retractedAt < d$cutoff))`,
        { cutoff },
      );

      // ~6 KB per 1536-dim float vector (1536 * 4 bytes + overhead). The
      // estimate is intentionally rough — it only exists for ops dashboards,
      // not billing.
      const bytesFreed = factsCompacted * 6 * 1024;
      this.logger.log(
        `Compacted ${factsCompacted} fact(s) in tenant ${companyId} (~${(bytesFreed / 1024 / 1024).toFixed(1)} MiB freed)`,
      );
      this.metrics?.countCompacted(factsCompacted);
      return { companyId, factsCompacted, bytesFreed };
    });
  }
}
