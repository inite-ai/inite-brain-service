import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { DistributedLeaseGuard, noteUnguarded } from '../common/distributed-lease.guard';
import {
  FACT_STATUSES,
  MetricsService,
  MemoryQualitySnapshot,
  STALE_BUCKETS_DAYS,
} from './metrics.service';

const LOCK_KEY = 'memory_quality';
/** Eight COUNT aggregates per tenant; half an hour covers the roster. */
const LEASE_TTL_SECONDS = 30 * 60;

/**
 * MemoryQualityService — nightly snapshot of "is the memory rotting"
 * signals, exported as Prometheus gauges (see MetricsService):
 *
 *   brain_memory_facts{status}                — competing backlog, growth
 *   brain_memory_stale_active_facts{older_than_days} — ageing active set
 *   brain_memory_fact_trust{band}             — drift toward low-trust sources
 *   brain_memory_orphan_entities              — entities with no active memory
 *   brain_policy_sets_active                  — ABAC sets in force fleet-wide
 *
 * Before this, these signals lived only in per-tenant log lines and
 * job_run.stats rows — nothing an operator could alert on. The pass is
 * read-only COUNT aggregates, but N replicas × every tenant × eight
 * aggregates is N× the load for one answer, so the 03:35 UTC pass
 * (between compaction 03:17 and the calibration refit 03:42) runs under
 * the distributed lease guard: one pod computes and publishes. The gauges
 * are per-pod, so aggregate across pods with max() in dashboards — a pod
 * that never held the lease exports nothing for the labelled series.
 *
 * No companyId label (unbounded cardinality) — values are summed across
 * tenants; per-tenant drill-down stays in logs.
 */
@Injectable()
export class MemoryQualityService {
  private readonly logger = new Logger(MemoryQualityService.name);

  // Fourth dep is the distributed lease guard for the nightly pass.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly metrics: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  @Cron('35 3 * * *', { timeZone: 'UTC' })
  async collectNightly(): Promise<void> {
    try {
      if (!this.guard) noteUnguarded(this.logger, 'memory-quality');
      const run = this.guard
        ? await this.guard.run(LOCK_KEY, () => this.collectNow(), LEASE_TTL_SECONDS)
        : await this.collectNow();
      if (run === null)
        this.logger.log('memory-quality pass skipped — another run holds the lease');
    } catch (e) {
      this.logger.warn(`memory-quality pass failed: ${(e as Error).message}`);
    }
  }

  /**
   * Compute the cross-tenant snapshot and publish it to the gauges.
   *
   * `tenantScope` overrides the roster: the nightly cron passes nothing and
   * fans out over the full production roster (ApiKeyService.knownCompanyIds()),
   * while a caller that needs a deterministic, self-contained measurement —
   * the e2e, where the shared test container's tenant_registry accumulates
   * every suite's tenants — passes an explicit tenant list. Production
   * behaviour is unchanged (enumerating every real tenant is correct there).
   */
  async collectNow(tenantScope?: readonly string[]): Promise<MemoryQualitySnapshot> {
    const snapshot: MemoryQualitySnapshot = {
      factsByStatus: {},
      staleActiveFacts: {},
      trustBands: { low: 0, neutral: 0, high: 0 },
      orphanEntities: 0,
      policySetsActive: 0,
    };
    let failed = 0;
    const tenants = tenantScope ?? this.apiKeys.knownCompanyIds();
    for (const companyId of tenants) {
      try {
        this.mergeInto(snapshot, await this.collectTenant(companyId));
      } catch (e) {
        failed++;
        this.logger.warn(`memory-quality for ${companyId} failed: ${(e as Error).message}`);
      }
    }
    this.metrics.setMemoryQuality(snapshot);
    this.logger.log(
      `memory-quality: tenants=${tenants.length} failed=${failed} ` +
        `active=${snapshot.factsByStatus['active'] ?? 0} ` +
        `competing=${snapshot.factsByStatus['competing'] ?? 0} ` +
        `orphans=${snapshot.orphanEntities}`,
    );
    return snapshot;
  }

  private async collectTenant(companyId: string): Promise<MemoryQualitySnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      const factsByStatus: Record<string, number> = {};
      const [statusRows] = await db.query<[Array<{ status: string; n: number }>]>(
        `SELECT status, count() AS n FROM knowledge_fact GROUP BY status`,
      );
      for (const r of (statusRows as Array<{ status: string; n: number }>) ?? []) {
        factsByStatus[r.status] = r.n;
      }

      const staleActiveFacts: Record<number, number> = {};
      for (const days of STALE_BUCKETS_DAYS) {
        // Cutoff computed in JS + type::datetime — parses on SurrealDB
        // 2.x and 3.x alike; both duration::from spellings are
        // version-specific parse errors on the other line.
        staleActiveFacts[days] = await this.countWhere(
          db,
          `status = 'active' AND recordedAt < type::datetime($cutoff)`,
          { cutoff: new Date(Date.now() - days * 86_400_000).toISOString() },
        );
      }

      // Same reputation ladder as read-time scoring (scoring.ts): a
      // learned rate of EXACTLY 0.5 is the "no signal" stamp and defers
      // to the declared tier; snapshot-less (pre-0044) facts land on the
      // neutral 0.5.
      const ladder = `(IF trustSnapshot.learnedTrust != NONE AND trustSnapshot.learnedTrust != 0.5
           THEN trustSnapshot.learnedTrust
           ELSE trustSnapshot.declaredTrust ?? 0.5 END)`;
      const low = await this.countWhere(db, `status = 'active' AND ${ladder} < 0.4`);
      const high = await this.countWhere(db, `status = 'active' AND ${ladder} > 0.6`);
      const active = factsByStatus['active'] ?? 0;
      const trustBands = {
        low,
        high,
        neutral: Math.max(0, active - low - high),
      };

      // Orphans = unmerged entities minus entities carrying ≥1 active
      // fact. Counts entities whose memory fully expired/retracted as
      // well as never-populated ones — both mean "nothing to retrieve".
      const unmerged = await this.countTable(
        db,
        `SELECT count() AS n FROM knowledge_entity WHERE mergedInto = NONE GROUP ALL`,
      );
      const withActive = await this.countTable(
        db,
        `SELECT count() AS n FROM (SELECT entityId FROM knowledge_fact WHERE status = 'active' GROUP BY entityId) GROUP ALL`,
      );
      // Sets in force = enforce or report_only; 'disabled' sets are
      // parked drafts. Tenants that predate migration 0056 have no
      // access_policy table — Surreal answers [] and the count is 0.
      const policySetsActive = await this.countTable(
        db,
        `SELECT count() AS n FROM access_policy WHERE mode IN ['enforce', 'report_only'] GROUP ALL`,
      );

      return {
        factsByStatus,
        staleActiveFacts,
        trustBands,
        orphanEntities: Math.max(0, unmerged - withActive),
        policySetsActive,
      };
    });
  }

  private async countWhere(
    db: { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]> },
    where: string,
    params?: Record<string, unknown>,
  ): Promise<number> {
    return this.countTable(
      db,
      `SELECT count() AS n FROM knowledge_fact WHERE ${where} GROUP ALL`,
      params,
    );
  }

  private async countTable(
    db: { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]> },
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<number> {
    const [rows] = (await db.query(sql, params)) as [Array<{ n: number }>];
    return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
  }

  private mergeInto(acc: MemoryQualitySnapshot, tenant: MemoryQualitySnapshot): void {
    for (const status of FACT_STATUSES) {
      const n = tenant.factsByStatus[status];
      if (n) acc.factsByStatus[status] = (acc.factsByStatus[status] ?? 0) + n;
    }
    for (const days of STALE_BUCKETS_DAYS) {
      acc.staleActiveFacts[days] =
        (acc.staleActiveFacts[days] ?? 0) + (tenant.staleActiveFacts[days] ?? 0);
    }
    acc.trustBands.low += tenant.trustBands.low;
    acc.trustBands.neutral += tenant.trustBands.neutral;
    acc.trustBands.high += tenant.trustBands.high;
    acc.orphanEntities += tenant.orphanEntities;
    acc.policySetsActive += tenant.policySetsActive;
  }
}
