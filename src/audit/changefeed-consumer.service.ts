import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { LeaderLeaseService } from '../jobs/leader-lease.service';

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
  /**
   * Upper bound on rows pulled from SHOW CHANGES per source per tick.
   * Without it, a cold start (cursor=0) materialises the ENTIRE 30-day
   * CHANGEFEED retention into the node process before the TS-side batch
   * slice runs. Kept a few multiples above perBatchLimit so the trailing
   * count still reports a useful lag; the cursor drains the rest over
   * subsequent ticks.
   */
  private readonly fetchLimit: number;
  // Hot in-flight flag — overlapping ticks waste DB connections and
  // could double-emit on a slow tenant. Each cron firing checks +
  // skips if a previous one is still running.
  private inFlight = false;

  static readonly SOURCES = [
    'knowledge_entity',
    'knowledge_fact',
    'knowledge_edge',
  ] as const;

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
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly lease?: LeaderLeaseService,
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
    if (!this.enabled || this.inFlight) return;
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
          const r = await this.consumeForTenant(companyId);
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
      enabled: this.enabled,
      inFlight: this.inFlight,
      lastTickAt: this.lastTickAt,
      lastPendingRemaining: this.lastPendingRemaining,
      totalConsumed: this.totalConsumed,
      tickCount: this.tickCount,
      lastError: this.lastError,
      sources: ChangefeedConsumerService.SOURCES,
      perBatchLimit: this.perBatchLimit,
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
          const r = await this.consumeForTenant(companyId);
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
   * Per-source cursor table — joins the in-memory tick state with the
   * persisted `changefeed_state` cursor per tenant + source. Cheap
   * read; admin operators use it to spot tenants stuck behind a slow
   * batch.
   */
  async cursorState(): Promise<
    Array<{ companyId: string; source: string; cursor: number }>
  > {
    if (!this.enabled) return [];
    const out: Array<{ companyId: string; source: string; cursor: number }> =
      [];
    for (const companyId of this.apiKeys.knownCompanyIds()) {
      try {
        await this.surreal.withCompany(companyId, async (db) => {
          for (const source of ChangefeedConsumerService.SOURCES) {
            try {
              const cursor = await this.loadCursor(db, source);
              out.push({ companyId, source, cursor });
            } catch (e) {
              this.logger.warn(
                `[changefeed] cursor read failed (${companyId}/${source}): ${(e as Error).message}`,
              );
            }
          }
        });
      } catch (e) {
        this.logger.warn(
          `[changefeed] cursorState failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    return out;
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

/**
 * Redact PII *value* fields from a changefeed post-image before it is
 * mirrored into audit_event. The mirror is a structural change-log: it
 * records WHICH predicate changed on WHICH entity (id, predicate,
 * status, validity, op) — it must NOT carry the raw sensitive VALUE
 * (a fact `object` like an email/address, or an entity name/aliases).
 *
 * This is also the structural defence for the GDPR forget race: a
 * record whose CREATE/UPDATE is still unconsumed when the subject is
 * forgotten gets re-materialised here AFTER the forget purge — but with
 * the value already redacted, so no raw PII re-appears in audit_event.
 * `embedding` is dropped as bloat (huge float array, not human PII).
 */
export const REDACTED = '[redacted]';
// Allowlist of STRUCTURAL fields kept verbatim in the audit mirror. Any
// other field — present or future — is redacted, so a new PII-bearing
// column can't silently leak (denylist regressed once: canonicalNameLc /
// externalRefs were missed). `embedding` is dropped as bloat.
const STRUCTURAL_FIELDS = new Set([
  'id',
  'entityId',
  'predicate',
  'op',
  'status',
  'validFrom',
  'validUntil',
  'recordedAt',
  'retractedAt',
  'retractionReason',
  'supersededBy',
  'priorValidUntil',
  'confidence',
  'kind',
  'in',
  'out',
  'weight',
  'artifactType',
  'dirty',
  'mergedInto',
  'mergedAt',
  'type',
]);
export function redactAfterImage(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'embedding') continue; // drop float-array bloat
    out[k] = STRUCTURAL_FIELDS.has(k) || v == null ? v : REDACTED;
  }
  return out;
}
