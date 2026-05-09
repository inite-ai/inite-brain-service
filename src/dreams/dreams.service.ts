import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { withSpan } from '../common/tracing';
import { DreamsDedupService, DedupResult } from './dedup.service';
import { DreamsResolverService, ResolverResult } from './resolver.service';
import { CompactionService } from '../compaction/compaction.service';
import { DreamsOperation } from './dto/run-dreams.dto';

export interface DreamsTenantStats {
  companyId: string;
  durationSeconds: number;
  dedup?: DedupResult;
  resolve?: ResolverResult;
  /**
   * The summarize op delegates to CompactionService.compactCompany,
   * which uses the injected SUMMARY_GENERATOR. We surface a flag
   * here just so callers know it ran; the full compaction stats
   * stay accessible via the existing /metrics surface.
   */
  summarized?: boolean;
  error?: string;
}

/**
 * DreamsService — orchestrates the off-hours self-improvement pass:
 *
 *   1. (optional) Compaction with LLM summary generator → richer
 *      warm-tier rollups. Triggered explicitly via `summarize`
 *      operation; in practice the daily compaction cron already
 *      runs this if DREAMS_LLM_SUMMARY_ENABLED=1.
 *   2. Near-duplicate entity dedup → identity_of links emitted
 *      automatically when an LLM judge confirms the match.
 *   3. Competing-fact auto-resolution → loser fact superseded with
 *      `retractionReason='dreams_resolution'` when an LLM judge
 *      breaks the tie; ambiguous pairs left for the operator.
 *
 * Cron: daily at 04:00 UTC, 43 minutes after the compaction cron
 * (03:17). The lag is intentional — dreams operates over the post-
 * compaction state so fresh summaries land before dedup / resolve
 * pull their context.
 *
 * Per-tenant fan-out: errors on one tenant log + continue. The
 * orchestrator is read-mostly; a Surreal hiccup on tenant N must
 * not stop tenant N+1.
 */
@Injectable()
export class DreamsService {
  private readonly logger = new Logger(DreamsService.name);
  private readonly enabled: boolean;
  private readonly defaultOps: ReadonlySet<DreamsOperation>;

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly dedup: DreamsDedupService,
    private readonly resolver: DreamsResolverService,
    private readonly compaction: CompactionService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      this.configService.get<string>('DREAMS_ENABLED', '0') === '1';
    // Default operation set: every sub-service that's been individually
    // enabled. An operator who only wants dedup flips
    // DREAMS_DEDUP_ENABLED=1 and DREAMS_ENABLED=1 — the cron then
    // skips the resolve / summarize legs.
    const ops: DreamsOperation[] = [];
    if (this.dedup.isEnabled()) ops.push('dedup');
    if (this.resolver.isEnabled()) ops.push('resolve');
    // summarize is always available because the no-LLM concat path
    // is the fallback; the LLM path engages when DREAMS_LLM_SUMMARY_ENABLED=1.
    if (
      this.configService.get<string>('DREAMS_RUN_SUMMARIZE', '0') === '1'
    ) {
      ops.push('summarize');
    }
    this.defaultOps = new Set(ops);
    this.logger.log(
      `Dreams config: enabled=${this.enabled}, default ops=${[...this.defaultOps].join(',') || '(none)'}`,
    );
  }

  /** Cron entry — daily at 04:00 UTC, 43 min after compaction (03:17). */
  @Cron('0 4 * * *', { timeZone: 'UTC' })
  async runDaily(): Promise<DreamsTenantStats[]> {
    if (!this.enabled) return [];
    return this.runAll();
  }

  /**
   * Iterate every known tenant. One bad tenant must not stop the
   * rest — errors are logged and folded into the per-tenant stats.
   */
  async runAll(operations?: DreamsOperation[]): Promise<DreamsTenantStats[]> {
    const tenants = this.apiKeys.knownCompanyIds();
    const ops = operations ? new Set(operations) : this.defaultOps;
    this.logger.log(
      `Dreams starting — ${tenants.length} tenant(s), ops=${[...ops].join(',') || '(none)'}`,
    );
    const out: DreamsTenantStats[] = [];
    for (const companyId of tenants) {
      try {
        out.push(await this.runForTenant(companyId, [...ops]));
      } catch (err) {
        const e = err as Error;
        this.logger.error(`Dreams failed for ${companyId}: ${e.message}`);
        this.metrics?.countDreams('failed');
        out.push({
          companyId,
          durationSeconds: 0,
          error: e.message,
        });
      }
    }
    const totalDedupLinks = out.reduce(
      (acc, r) => acc + (r.dedup?.identityLinksCreated ?? 0),
      0,
    );
    const totalResolutions = out.reduce(
      (acc, r) => acc + (r.resolve?.resolutionsApplied ?? 0),
      0,
    );
    this.logger.log(
      `Dreams done — ${out.length} tenant(s), ${totalDedupLinks} identity link(s), ` +
        `${totalResolutions} resolution(s) applied`,
    );
    return out;
  }

  /**
   * Run one tenant. Wraps the SurrealDB connection acquisition so
   * each sub-service receives the same scoped handle. Operations
   * run sequentially — dedup tweaks the graph, which the resolver
   * then sees a cleaner context for. Order: dedup → resolve →
   * summarize.
   */
  async runForTenant(
    companyId: string,
    operations: DreamsOperation[],
  ): Promise<DreamsTenantStats> {
    const t0 = Date.now();
    const stats: DreamsTenantStats = {
      companyId,
      durationSeconds: 0,
    };
    const opSet = new Set(operations);

    await this.surreal.withCompany(companyId, async (db) => {
      if (opSet.has('dedup')) {
        stats.dedup = await withSpan(
          'dreams.dedup',
          () => this.dedup.run(db),
          { 'dreams.tenant': companyId },
        );
      }
      if (opSet.has('resolve')) {
        stats.resolve = await withSpan(
          'dreams.resolve',
          () => this.resolver.run(db),
          { 'dreams.tenant': companyId },
        );
      }
    });

    if (opSet.has('summarize')) {
      // Compaction owns its own connection lifecycle (it iterates
      // over knowledge_fact in batches and updates statuses), so we
      // delegate rather than threading the existing db handle in.
      try {
        await withSpan(
          'dreams.summarize',
          () => this.compaction.compactCompany(companyId),
          { 'dreams.tenant': companyId },
        );
        stats.summarized = true;
      } catch (err) {
        this.logger.warn(
          `Dreams summarize failed for ${companyId}: ${(err as Error).message}`,
        );
        stats.summarized = false;
      }
    }

    stats.durationSeconds = (Date.now() - t0) / 1000;
    this.metrics?.countDreams('ok');
    if (stats.dedup) {
      this.metrics?.countDreamsEmitted(
        'identity_link',
        stats.dedup.identityLinksCreated,
      );
    }
    if (stats.resolve) {
      this.metrics?.countDreamsEmitted(
        'resolution',
        stats.resolve.resolutionsApplied,
      );
    }
    if (stats.summarized) {
      this.metrics?.countDreamsEmitted('summary', 1);
    }
    return stats;
  }
}
