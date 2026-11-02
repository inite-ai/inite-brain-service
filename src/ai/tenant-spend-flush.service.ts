import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { retryOnReadConflict } from '../db/surreal-retry';
import { MetricsService } from '../metrics/metrics.service';
import { llmBudgetGauges } from '../metrics/llm-budget-gauges';
import {
  applySharedSpend,
  restorePendingSpend,
  takePendingSpend,
  tenantsSeen,
  utcDay,
} from './tenant-llm-budget';

/** How often a replica shares what it spent and reads the others' back. */
const FLUSH_INTERVAL_MS = 60_000;
/** Days of rows kept; older ones are swept. */
const KEEP_DAYS = 7;
const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Shares the per-tenant model spend between replicas (#853,
 * tenant-llm-budget.ts): once a minute it adds this replica's pending
 * tokens to the tenant's row for the day (migration 0183, system database)
 * and reads the shared totals back for every tenant it has seen today, so
 * every replica enforces the same budget within a minute. A flush that
 * fails hands its tokens back to be carried by the next one.
 */
@Injectable()
export class TenantSpendFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantSpendFlushService.name);
  private timer: NodeJS.Timeout | undefined;
  private lastSweepAt = 0;

  constructor(
    private readonly surreal: SurrealService,
    @Optional() metrics?: MetricsService,
  ) {
    if (metrics) llmBudgetGauges(metrics.registry);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  async flush(now: Date = new Date()): Promise<void> {
    const pending = takePendingSpend();
    const day = utcDay(now);
    const tenants = [...new Set([...tenantsSeen(now), ...pending.map((p) => p.tenant)])];
    if (tenants.length === 0) return;
    try {
      await this.surreal.withAdminDb(async (db) => {
        for (const p of pending) {
          await retryOnReadConflict(() =>
            db.query(
              `UPSERT type::record('llm_tenant_spend', $id) SET
                 companyId = $tenant, day = $day,
                 tokens = (tokens ?? 0) + $tokens, updatedAt = time::now()`,
              { id: `${p.tenant}:${p.day}`, tenant: p.tenant, day: p.day, tokens: p.tokens },
            ),
          );
        }
        for (const tenant of tenants) {
          const [row] = await queryRows<{ tokens?: number }>(
            db,
            `SELECT tokens FROM type::record('llm_tenant_spend', $id)`,
            { id: `${tenant}:${day}` },
          );
          applySharedSpend(tenant, day, row?.tokens ?? 0);
        }
        await this.sweepIfDue(db, now);
      });
    } catch (e) {
      restorePendingSpend(pending);
      // Ids and counts only — never memory content.
      this.logger.warn(
        `Tenant model spend flush failed (${tenants.length} tenants): ${(e as Error).message}`,
      );
    }
  }

  private async sweepIfDue(
    db: Parameters<Parameters<SurrealService['withAdminDb']>[0]>[0],
    now: Date,
  ): Promise<void> {
    if (now.getTime() - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now.getTime();
    const cutoff = utcDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    // SELECT-ids-then-DELETE: the 3.2.4 discipline.
    const ids = await queryRows<unknown>(
      db,
      `SELECT VALUE id FROM llm_tenant_spend WHERE day < $cutoff LIMIT 1000`,
      { cutoff },
    );
    if (ids.length > 0) await db.query(`DELETE $ids`, { ids });
  }
}
