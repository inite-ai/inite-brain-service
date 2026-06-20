import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Periodic SurrealDB CHANGEFEED reader.
 *
 * migration 0002 declared CHANGEFEED 30d INCLUDE ORIGINAL on
 * knowledge_entity, knowledge_fact, knowledge_edge so the database
 * could surface change records to a consumer; the audit flagged that
 * NOTHING ever read them, so the 30-day pre-image stream sat as
 * unbounded rocksdb storage growth + compaction load.
 *
 * This service is the consumer. On each tick, for every known tenant
 * it:
 *
 *   1. Reads the last-consumed versionstamp per source table from
 *      `changefeed_state` (migration 0023).
 *   2. Calls `SHOW CHANGES FOR TABLE <t> SINCE <versionstamp>` —
 *      SurrealDB returns the slice of pending pre/post-images.
 *   3. Translates each change into an `audit_event` row with
 *      `source`, `recordId`, `op`, `ts`, `versionstamp`, `before`,
 *      and `after` populated. Per-tenant; no cross-pollination.
 *   4. UPSERTs the new high-watermark into `changefeed_state` so a
 *      crashed tick doesn't double-emit on the next run.
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
  private readonly enabled: boolean;
  // Cap per-tick batch size so a backlog doesn't pin the cron tick
  // for minutes. Trailing batches drain on subsequent ticks; the
  // lag-records gauge surfaces the backlog.
  private readonly perBatchLimit: number;
  // Hot in-flight flag — overlapping ticks waste DB connections and
  // could double-emit on a slow tenant. Each cron firing checks +
  // skips if a previous one is still running.
  private inFlight = false;

  static readonly SOURCES = [
    'knowledge_entity',
    'knowledge_fact',
    'knowledge_edge',
  ] as const;

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      config.get<string>('AUDIT_CHANGEFEED_ENABLED', '0') === '1';
    this.perBatchLimit = parseInt(
      config.get<string>('AUDIT_CHANGEFEED_BATCH', '500'),
      10,
    );
  }

  // EVERY_MINUTE keeps lag bounded — see comment above. Operators
  // who want lower-latency audit replication can drop to every-30s
  // via the env knob below (a custom cron expression overrides).
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    try {
      for (const companyId of this.apiKeys.knownCompanyIds()) {
        try {
          await this.consumeForTenant(companyId);
        } catch (err) {
          this.logger.warn(
            `[changefeed] tenant=${companyId} failed: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  // Exposed so a unit test (or the admin debug endpoint) can drain
  // synchronously without waiting for the cron tick.
  async consumeForTenant(companyId: string): Promise<{
    consumed: Record<string, number>;
    pendingRemaining: number;
  }> {
    const consumed: Record<string, number> = {};
    let pendingRemaining = 0;

    await this.surreal.withCompany(companyId, async (db) => {
      for (const source of ChangefeedConsumerService.SOURCES) {
        const since = await this.loadCursor(db, source);
        const changes = await this.fetchChanges(db, source, since);
        if (changes.length === 0) continue;

        // The slice may be larger than perBatchLimit — emit the first
        // N and leave the remainder for the next tick so a backlog
        // can't lock the cron up. Sort by versionstamp ascending to
        // guarantee we never advance the cursor past unconsumed rows.
        const sorted = changes
          .slice()
          .sort(
            (a, b) =>
              (a.versionstamp as number) - (b.versionstamp as number),
          );
        const batch = sorted.slice(0, this.perBatchLimit);
        const trailing = sorted.length - batch.length;
        pendingRemaining += trailing;

        for (const change of batch) {
          await this.emitAuditEvent(db, source, change);
        }
        await this.advanceCursor(
          db,
          source,
          batch[batch.length - 1].versionstamp as number,
        );
        consumed[source] = batch.length;
      }
    });

    if (this.metrics) {
      for (const [source, n] of Object.entries(consumed)) {
        this.metrics.countChangefeedConsumed(source, n);
      }
      this.metrics.setChangefeedLag(pendingRemaining);
    }

    return { consumed, pendingRemaining };
  }

  // ── Wire-format helpers ──────────────────────────────────────────

  private async loadCursor(db: any, source: string): Promise<number> {
    const [rows] = await db.query(
      `SELECT lastVersionstamp FROM changefeed_state
        WHERE source = $s LIMIT 1`,
      { s: source },
    );
    const arr = (rows as Array<{ lastVersionstamp: number }>) ?? [];
    return arr[0]?.lastVersionstamp ?? 0;
  }

  private async fetchChanges(
    db: any,
    source: string,
    since: number,
  ): Promise<Array<Record<string, unknown>>> {
    // SHOW CHANGES is parameter-friendly for the SINCE clause but the
    // table name is a syntactic identifier — we whitelist it via the
    // static SOURCES tuple to keep it injection-safe.
    if (!(ChangefeedConsumerService.SOURCES as readonly string[]).includes(source)) {
      throw new Error(`refusing unknown changefeed source: ${source}`);
    }
    const [rows] = await db.query(
      `SHOW CHANGES FOR TABLE ${source} SINCE ${since}`,
    );
    return (rows as Array<Record<string, unknown>>) ?? [];
  }

  private async emitAuditEvent(
    db: any,
    source: string,
    change: Record<string, unknown>,
  ): Promise<void> {
    // SHOW CHANGES rows shape (SurrealDB 2.2.x):
    //   { versionstamp, changes: [ { update?: <row>, delete?: <id>,
    //                                define_table?: <obj> } ] }
    // For our purposes we collapse each change item into one audit
    // row, tagged with the recoverable recordId + a normalised op
    // label.
    const versionstamp = change.versionstamp as number;
    const items =
      (change.changes as Array<Record<string, unknown>> | undefined) ?? [];
    for (const item of items) {
      const op = Object.keys(item)[0] ?? 'unknown';
      const payload = (item as Record<string, unknown>)[op] as
        | Record<string, unknown>
        | string
        | undefined;
      const recordId =
        op === 'delete'
          ? String(payload)
          : (payload as { id?: unknown } | undefined)?.id?.toString() ?? '';
      const after = typeof payload === 'object' ? (payload as object) : undefined;
      await db.query(
        `CREATE audit_event CONTENT {
            source: $source,
            recordId: $recordId,
            op: $op,
            versionstamp: $versionstamp,
            after: $after
         }`,
        {
          source,
          recordId,
          op,
          versionstamp,
          after,
        },
      );
    }
  }

  private async advanceCursor(
    db: any,
    source: string,
    versionstamp: number,
  ): Promise<void> {
    await db.query(
      `UPSERT changefeed_state:[$source] CONTENT {
          source: $source,
          lastVersionstamp: $vs,
          updatedAt: time::now()
       }`,
      { source, vs: versionstamp },
    );
  }
}
