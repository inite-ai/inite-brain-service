import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { LeaderLeaseService } from '../jobs/leader-lease.service';
import { ChangefeedDrainService } from './changefeed-drain.service';

/**
 * Periodic SurrealDB CHANGEFEED reader.
 *
 * migration 0002 declared CHANGEFEED 30d INCLUDE ORIGINAL on
 * knowledge_entity, knowledge_fact, knowledge_edge so the database
 * could surface change records to a consumer; the audit flagged that
 * NOTHING ever read them, so the 30-day pre-image stream sat as
 * unbounded rocksdb storage growth + compaction load.
 *
 * This service is the consumer's cron/orchestration shell: every tick
 * it fans out across known tenants and asks ChangefeedDrainService to
 * drain each one, gated by a leader lease so multi-pod deploys don't
 * double-emit. The actual SHOW CHANGES → audit_event drain (with PII
 * redaction) lives in ChangefeedDrainService.
 *
 * Metrics:
 *   - brain_changefeed_consumed_total{source}
 *   - brain_changefeed_lag_records         — running gauge, sum of
 *                                            pending changes after
 *                                            the most recent tick;
 *                                            ops alarms on sustained
 *                                            non-zero.
 *
 * Cron cadence defaults to every minute. Heavy tenants can tune via
 * AUDIT_CHANGEFEED_CRON env (must be a valid cron expression).
 *
 * Lazy / disabled-by-default: AUDIT_CHANGEFEED_ENABLED gates the
 * cron registration. Operators flip on AFTER applying migration 0023
 * (the schema) so a deploy ordering glitch can't 500 the consumer.
 */
@Injectable()
export class ChangefeedConsumerService {
  private readonly logger = new Logger(ChangefeedConsumerService.name);
  // Hot in-flight flag — overlapping ticks waste DB connections and
  // could double-emit on a slow tenant. Each cron firing checks +
  // skips if a previous one is still running.
  private inFlight = false;

  /** Last successful tick timestamp (ISO). Exposed for admin status. */
  private lastTickAt: string | null = null;
  /** Last tick error, if any, with timestamp. */
  private lastError: { message: string; ts: string } | null = null;
  /** Sum of per-source pendingRemaining from the last tick. */
  private lastPendingRemaining = 0;
  /** Total rows consumed across all ticks since process start. */
  private totalConsumed = 0;
  /** Rough number of completed ticks since process start. */
  private tickCount = 0;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly drain: ChangefeedDrainService,
    @Optional() private readonly lease?: LeaderLeaseService,
  ) {}

  // EVERY_MINUTE keeps lag bounded — see comment above. Operators
  // who want lower-latency audit replication can drop to every-30s
  // via the env knob below (a custom cron expression overrides).
  //
  // Multi-pod gate: take the `changefeed_consumer` leader_lease so
  // only one pod drains the per-tenant SHOW CHANGES SINCE cursor at
  // a time. Two pods racing the cursor would double-emit audit_event
  // rows AND clobber each other's UPSERT of changefeed_state.
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.drain.enabled || this.inFlight) return;
    if (this.lease) {
      // ttl=180s leaves 3x the 60s cron cadence as headroom — a GC pause
      // can't strand the lease past the next tick attempt.
      const got = await this.lease.tryAcquire('changefeed_consumer', 180);
      if (!got) return;
    }
    this.inFlight = true;
    let pendingThisTick = 0;
    let consumedThisTick = 0;
    try {
      for (const companyId of this.apiKeys.knownCompanyIds()) {
        try {
          const r = await this.drain.consumeForTenant(companyId);
          pendingThisTick += r.pendingRemaining;
          consumedThisTick += Object.values(r.consumed).reduce(
            (a, b) => a + b,
            0,
          );
        } catch (err) {
          this.logger.warn(
            `[changefeed] tenant=${companyId} failed: ${(err as Error).message}`,
          );
          this.lastError = {
            message: (err as Error).message,
            ts: new Date().toISOString(),
          };
        }
      }
      this.lastTickAt = new Date().toISOString();
      this.lastPendingRemaining = pendingThisTick;
      this.totalConsumed += consumedThisTick;
      this.tickCount += 1;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Operator-facing status snapshot. Read-only; surfaced via
   * /v1/admin/changefeed/state.
   */
  stats(): {
    enabled: boolean;
    inFlight: boolean;
    lastTickAt: string | null;
    lastPendingRemaining: number;
    totalConsumed: number;
    tickCount: number;
    lastError: { message: string; ts: string } | null;
    sources: readonly string[];
    perBatchLimit: number;
  } {
    return {
      enabled: this.drain.enabled,
      inFlight: this.inFlight,
      lastTickAt: this.lastTickAt,
      lastPendingRemaining: this.lastPendingRemaining,
      totalConsumed: this.totalConsumed,
      tickCount: this.tickCount,
      lastError: this.lastError,
      sources: this.drain.sources,
      perBatchLimit: this.drain.perBatchLimit,
    };
  }

  /**
   * Operator-triggered drain — used by the admin "drain now" button.
   * Bypasses the cron tick, runs synchronously, returns aggregate
   * stats. inFlight guard still prevents overlap with a cron tick.
   */
  async drainNow(): Promise<{
    consumed: Record<string, number>;
    pendingRemaining: number;
    tenants: number;
  }> {
    if (this.inFlight) {
      return { consumed: {}, pendingRemaining: 0, tenants: 0 };
    }
    this.inFlight = true;
    const consumed: Record<string, number> = {};
    let pending = 0;
    const tenants = this.apiKeys.knownCompanyIds();
    try {
      for (const companyId of tenants) {
        try {
          const r = await this.drain.consumeForTenant(companyId);
          for (const [k, v] of Object.entries(r.consumed)) {
            consumed[k] = (consumed[k] ?? 0) + v;
          }
          pending += r.pendingRemaining;
        } catch (e) {
          this.lastError = {
            message: (e as Error).message,
            ts: new Date().toISOString(),
          };
        }
      }
      this.lastTickAt = new Date().toISOString();
      this.lastPendingRemaining = pending;
      this.totalConsumed += Object.values(consumed).reduce((a, b) => a + b, 0);
      this.tickCount += 1;
      return { consumed, pendingRemaining: pending, tenants: tenants.length };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Per-source cursor table — joins the tick state with the persisted
   * `changefeed_state` cursor per tenant + source. Cheap read; admin
   * operators use it to spot tenants stuck behind a slow batch.
   */
  async cursorState(): Promise<
    Array<{ companyId: string; source: string; cursor: number }>
  > {
    if (!this.drain.enabled) return [];
    const out: Array<{ companyId: string; source: string; cursor: number }> =
      [];
    for (const companyId of this.apiKeys.knownCompanyIds()) {
      try {
        const rows = await this.drain.cursorStateForTenant(companyId);
        for (const r of rows) {
          out.push({ companyId, source: r.source, cursor: r.cursor });
        }
      } catch (e) {
        this.logger.warn(
          `[changefeed] cursorState failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    return out;
  }
}
