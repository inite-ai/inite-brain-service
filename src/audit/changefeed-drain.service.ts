import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { redactAfterImage } from './changefeed-redaction';

/**
 * ChangefeedDrainService — the per-tenant CHANGEFEED drain engine.
 *
 * Owns the actual work: read the per-source cursor, `SHOW CHANGES FOR
 * TABLE … SINCE`, translate each change into an `audit_event` row
 * (PII-redacted post-image), bulk-insert, and advance the cursor. Also
 * owns the batch/fetch limits and the AUDIT_CHANGEFEED_ENABLED gate.
 * The cron cadence, leader election, tenant fan-out, and operator
 * status live in ChangefeedConsumerService, which delegates here.
 * Splitting the drain out keeps both classes' injected-dep lists ≤3.
 */
@Injectable()
export class ChangefeedDrainService {
  private readonly logger = new Logger(ChangefeedDrainService.name);
  readonly enabled: boolean;
  // Cap per-tick batch size so a backlog doesn't pin the cron tick
  // for minutes. Trailing batches drain on subsequent ticks; the
  // lag-records gauge surfaces the backlog.
  readonly perBatchLimit: number;
  /**
   * Upper bound on rows pulled from SHOW CHANGES per source per tick.
   * Without it, a cold start (cursor=0) materialises the ENTIRE 30-day
   * CHANGEFEED retention into the node process before the TS-side batch
   * slice runs. Kept a few multiples above perBatchLimit so the trailing
   * count still reports a useful lag; the cursor drains the rest over
   * subsequent ticks.
   */
  private readonly fetchLimit: number;

  static readonly SOURCES = [
    'knowledge_entity',
    'knowledge_fact',
    'knowledge_edge',
  ] as const;

  get sources(): readonly string[] {
    return ChangefeedDrainService.SOURCES;
  }

  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      config.get<string>('AUDIT_CHANGEFEED_ENABLED', '0') === '1';
    this.perBatchLimit = parseInt(
      config.get<string>('AUDIT_CHANGEFEED_BATCH', '500'),
      10,
    );
    const fetchLimit = parseInt(
      config.get<string>('AUDIT_CHANGEFEED_FETCH_LIMIT', '5000'),
      10,
    );
    // Never fetch fewer than we process in a tick, else we'd starve;
    // fall back to a sane default if the env value is garbage (the value
    // is interpolated into the SHOW CHANGES LIMIT clause, so NaN would
    // produce invalid SurrealQL).
    const safeBatch = Number.isFinite(this.perBatchLimit)
      ? this.perBatchLimit
      : 500;
    this.fetchLimit = Math.max(
      Number.isFinite(fetchLimit) ? fetchLimit : 5000,
      safeBatch,
    );
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
      for (const source of ChangefeedDrainService.SOURCES) {
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

        // Bulk-insert the whole batch in one round-trip. Sequential
        // CREATE was the bottleneck under load: 500 changes × 3 sources
        // × 50 tenants = 75K serial round-trips per tick, easily
        // overflowing the EVERY_MINUTE budget. INSERT INTO ... [..]
        // takes one RTT per source instead.
        const events = this.buildAuditEventBatch(source, batch);
        if (events.length > 0) {
          await db.query(
            `INSERT INTO audit_event $events`,
            { events },
          );
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

  /** Per-source cursor snapshot for ONE tenant. */
  async cursorStateForTenant(
    companyId: string,
  ): Promise<Array<{ source: string; cursor: number }>> {
    const out: Array<{ source: string; cursor: number }> = [];
    await this.surreal.withCompany(companyId, async (db) => {
      for (const source of ChangefeedDrainService.SOURCES) {
        try {
          const cursor = await this.loadCursor(db, source);
          out.push({ source, cursor });
        } catch (e) {
          this.logger.warn(
            `[changefeed] cursor read failed (${companyId}/${source}): ${(e as Error).message}`,
          );
        }
      }
    });
    return out;
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
    if (!(ChangefeedDrainService.SOURCES as readonly string[]).includes(source)) {
      throw new Error(`refusing unknown changefeed source: ${source}`);
    }
    const [rows] = await db.query(
      `SHOW CHANGES FOR TABLE ${source} SINCE ${since} LIMIT ${this.fetchLimit}`,
    );
    const changes = (rows as Array<Record<string, unknown>>) ?? [];
    // SurrealDB's SHOW CHANGES ... SINCE <vs> is inclusive of the boundary
    // versionstamp: a cursor parked at the last consumed vs would re-surface
    // that same row on the next tick → duplicate audit_event. Drop anything
    // at or below the cursor. Idempotent regardless of the DB's exact
    // boundary semantics; cold start (since=0) keeps all real changes since
    // versionstamps are strictly positive.
    if (since > 0) {
      return changes.filter((c) => (c.versionstamp as number) > since);
    }
    return changes;
  }

  /**
   * Flatten a batch of SHOW CHANGES rows into the audit_event shape.
   *
   * Each `change` row carries one or more items (`update` / `delete` /
   * `define_table`); each item becomes one audit_event. We compute
   * the array once so the consumer can submit them in a single
   * `INSERT INTO audit_event [..]` round-trip instead of N serial
   * CREATEs. Returning the array (not awaiting per-row) is what makes
   * the operation bulk-able.
   */
  private buildAuditEventBatch(
    source: string,
    changes: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const change of changes) {
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
        const after =
          typeof payload === 'object'
            ? redactAfterImage(payload as Record<string, unknown>)
            : undefined;
        out.push({
          source,
          recordId,
          op,
          versionstamp,
          after,
        });
      }
    }
    return out;
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
