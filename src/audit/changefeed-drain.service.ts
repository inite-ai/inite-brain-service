import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { redactAfterImage } from './changefeed-redaction';
import { changefeedOp, changefeedRecordId, changefeedRow } from '../db/changefeed-row';
import { envFlagEnabled } from '../common/env-validation';

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

  static readonly SOURCES = ['knowledge_entity', 'knowledge_fact', 'knowledge_edge'] as const;

  get sources(): readonly string[] {
    return ChangefeedDrainService.SOURCES;
  }

  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled = envFlagEnabled(config.get<string>('AUDIT_CHANGEFEED_ENABLED'));
    this.perBatchLimit = parseInt(config.get<string>('AUDIT_CHANGEFEED_BATCH', '500'), 10);
    // Never fetch fewer than we process in a tick, else we'd starve;
    // fall back to a sane default if the env value is garbage (the value
    // is interpolated into the SHOW CHANGES LIMIT clause, so NaN would
    // produce invalid SurrealQL).
    const safeBatch = Number.isFinite(this.perBatchLimit) ? this.perBatchLimit : 500;
    // Default fetch = batch + 1: SHOW CHANGES has no offset, so rows
    // fetched past the batch are re-fetched every tick until the cursor
    // catches up — the old 5000 default re-shipped up to 4500 rows
    // (with INCLUDE ORIGINAL pre-images) per source per tick during a
    // backlog, ~10x wasted transfer to compute a depth number. The +1
    // keeps "backlog exists" (pendingRemaining > 0) observable;
    // operators who want true depth raise AUDIT_CHANGEFEED_FETCH_LIMIT.
    const fetchLimit = parseInt(
      config.get<string>('AUDIT_CHANGEFEED_FETCH_LIMIT', String(safeBatch + 1)),
      10,
    );
    this.fetchLimit = Math.max(Number.isFinite(fetchLimit) ? fetchLimit : safeBatch + 1, safeBatch);
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
        // Compare, don't subtract: versionstamps are bigint on 3.x and
        // `bigint - bigint` is fine but `number - number` from a unit stub
        // isn't a bigint — a comparison works for both without conversion.
        const sorted = changes.slice().sort((a, b) => {
          const av = a.versionstamp as bigint;
          const bv = b.versionstamp as bigint;
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
        const batch = sorted.slice(0, this.perBatchLimit);
        const trailing = sorted.length - batch.length;
        pendingRemaining += trailing;

        // Emit the batch AND advance the cursor in ONE transaction. They
        // were two separate round-trips before: a crash in the gap either
        // re-inserted the whole batch on restart (INSERT succeeded, cursor
        // never advanced) or dropped it (cursor advanced first) — R4 #3.
        // `runTransaction` sends both as one BEGIN…COMMIT block (the driver
        // rejects BEGIN/COMMIT issued as separate query() calls). The batch
        // still travels in a single INSERT so the per-tick round-trip count
        // stays at one per (tenant × source) — the load fix that replaced
        // 75K serial CREATEs.
        const events = this.buildAuditEventBatch(source, batch);
        const lastChange = batch[batch.length - 1];
        const lastVs = lastChange ? (lastChange.versionstamp as bigint) : undefined;
        if (lastVs !== undefined) {
          await runTransaction(db, (tx) => {
            // INSERT IGNORE: each event carries a deterministic record id
            // (source+versionstamp+ordinal), so a re-drain of the same
            // window collides on the primary key and no-ops instead of
            // duplicating — idempotent without a UNIQUE index / migration.
            if (events.length > 0) {
              tx.add('INSERT IGNORE INTO audit_event $events').bind('events', events);
            }
            tx.add(
              `UPSERT changefeed_state:[$source] CONTENT {
                  source: $source,
                  lastVersionstamp: $vs,
                  updatedAt: time::now()
               }`,
            )
              .bind('source', source)
              .bind('vs', lastVs);
          });
        }
        consumed[source] = batch.length;
      }
    });

    if (this.metrics) {
      for (const [source, n] of Object.entries(consumed)) {
        this.metrics.countChangefeedConsumed(source, n);
      }
      // NOTE: the lag gauge is set by the consumer AFTER the tenant loop
      // with the summed value. Setting it here per tenant made the gauge
      // last-tenant-wins — a backlog on any tenant but the last was
      // invisible to "sustained non-zero" alerting.
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
          // Display value only (operator gauge): coerce the bigint cursor to a
          // number so the admin JSON response can serialise it — JSON.stringify
          // throws on a bigint. Precision loss on a ~1e17 versionstamp is
          // immaterial for spotting a stuck tenant.
          out.push({ source, cursor: Number(cursor) });
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

  private async loadCursor(db: Surreal, source: string): Promise<bigint> {
    const [rows] = await db.query(
      `SELECT lastVersionstamp FROM changefeed_state
        WHERE source = $s LIMIT 1`,
      { s: source },
    );
    const arr = (rows as Array<{ lastVersionstamp: number | bigint }>) ?? [];
    // bigint throughout — see fetchChanges. BigInt() accepts the stored int
    // (number or bigint) and the 0 cold-start default alike.
    return BigInt(arr[0]?.lastVersionstamp ?? 0);
  }

  private async fetchChanges(
    db: Surreal,
    source: string,
    since: bigint,
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
    const raw = (rows as Array<Record<string, unknown>>) ?? [];
    // SurrealDB 3.x returns the SHOW CHANGES versionstamp as a u64 BigInt
    // (~1.17e17 — far above Number.MAX_SAFE_INTEGER, so Number() would both
    // lose precision AND fail to re-encode). Keep it bigint ONCE, here, so
    // every downstream consumer (sort, boundary filter, deterministic id,
    // cursor UPSERT) stays bigint-typed — mixing bigint and number in
    // arithmetic throws. A unit stub that emits plain-number versionstamps is
    // normalised the same way (BigInt(10) === 10n).
    const changes = raw.map((c) => ({
      ...c,
      versionstamp: BigInt(c.versionstamp as number | bigint),
    }));
    // SurrealDB's SHOW CHANGES ... SINCE <vs> is inclusive of the boundary
    // versionstamp: a cursor parked at the last consumed vs would re-surface
    // that same row on the next tick → duplicate audit_event. Drop anything
    // at or below the cursor. Idempotent regardless of the DB's exact
    // boundary semantics; cold start (since=0) keeps all real changes since
    // versionstamps are strictly positive.
    if (since > 0n) {
      return changes.filter((c) => (c.versionstamp as bigint) > since);
    }
    return changes;
  }

  /**
   * Flatten a batch of SHOW CHANGES rows into the audit_event shape.
   *
   * Each `change` row carries one or more items (create / update / delete /
   * define_table); each item becomes one audit_event. Shape parsing goes
   * through the shared `changefeedRow` / `changefeedRecordId` / `changefeedOp`
   * helpers — the old ad-hoc `Object.keys(item)[0]` read the reverse PATCH
   * ARRAY that `INCLUDE ORIGINAL` puts under `update` on an UPDATE (the real
   * post-image is under `current`), so every update was mislabelled and its
   * `after` image was garbage (R4 #3).
   *
   * Each event gets a DETERMINISTIC record id — `<source>_<versionstamp>_<ordinal>`
   * — so a re-drain of the same change window produces the same ids and the
   * `INSERT IGNORE` in `consumeForTenant` no-ops the duplicates. We compute the
   * array once so the whole batch rides one INSERT round-trip.
   */
  private buildAuditEventBatch(
    source: string,
    changes: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const change of changes) {
      const versionstamp = change.versionstamp as bigint;
      const items = (change.changes as Array<Record<string, unknown>> | undefined) ?? [];
      for (const [ordinal, item] of items.entries()) {
        const op = changefeedOp(item);
        const recordId = changefeedRecordId(item) ?? '';
        const row = changefeedRow(item);
        const event: Record<string, unknown> = {
          // A full record id (`audit_event:<key>`) makes the id the primary
          // key, so INSERT IGNORE dedupes on re-drain. Key parts are numeric /
          // table-name tokens → a plain, unquoted-safe id tail.
          id: new StringRecordId(`audit_event:${source}_${versionstamp}_${ordinal}`),
          source,
          recordId,
          op,
          versionstamp,
        };
        if (row) event.after = redactAfterImage(row);
        out.push(event);
      }
    }
    return out;
  }
}
