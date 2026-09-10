import { Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import {
  SurrealService,
  queryRows,
  retryOnUniqueViolation,
  runTransaction,
} from '../db/surreal.service';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** One throttler hit, as the ThrottlerStorage contract spells it out positionally. */
interface Hit {
  key: string;
  ttl: number;
  limit: number;
  blockDuration: number;
  throttlerName: string;
}

/** What the bucket transaction hands back; datetimes arrive as Date on 3.x, ISO via JSON. */
interface BucketRow {
  hits: number;
  expiresAt: string | Date;
  blockedUntil?: string | Date | null;
}

/** How often one process sweeps expired buckets out of the shared table. */
const GC_INTERVAL_MS = 10 * 60_000;
/** Outage log cadence: one line per window, not one per throttled request. */
const FAILURE_LOG_INTERVAL_MS = 30_000;

/**
 * Rate-limit buckets shared by every replica: one `throttle_bucket` row
 * per (throttler, tracker key) in the system database, migration 0141.
 * A hit is ONE round trip — a point-read + UPSERT transaction that resets
 * an expired window in place and applies the NestJS blockDuration
 * semantics (overflow → blocked until `blockedUntil`) — so N replicas
 * share one count instead of each granting the full limit.
 *
 * Fails over, never closed: when the database is unreachable the hit is
 * counted in the per-process in-memory storage (the pre-0141 behaviour)
 * and the outage is logged, so a throttler outage cannot take the API
 * down. Expired rows are swept opportunistically from the write path, at
 * most once per GC_INTERVAL_MS per process — no cron.
 *
 * Without a SurrealService (unit fixtures) it IS the in-memory storage.
 */
@Injectable()
export class SurrealThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(SurrealThrottlerStorage.name);
  private readonly local = new ThrottlerStorageService();
  private lastGcAt = 0;
  private lastFailureLogAt = 0;

  constructor(@Optional() private readonly surreal?: SurrealService) {}

  // Positional signature mandated by @nestjs/throttler's ThrottlerStorage.
  // eslint-disable-next-line max-params
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<StorageRecord> {
    const hit: Hit = { key, ttl, limit, blockDuration, throttlerName };
    if (!this.surreal) return this.localIncrement(hit);
    try {
      const record = await this.sharedIncrement(hit);
      this.sweepIfDue();
      return record;
    } catch (e) {
      this.noteFailure(e as Error);
      return this.localIncrement(hit);
    }
  }

  onApplicationShutdown(): void {
    this.local.onApplicationShutdown();
  }

  /**
   * Delete buckets whose window and block have both passed. Public so a
   * spec can drive it; production calls it from sweepIfDue(). Returns
   * the number of rows removed.
   */
  async sweepExpired(): Promise<number> {
    if (!this.surreal) return 0;
    return this.surreal.withAdminDb(async (db) => {
      // SELECT-ids-then-DELETE: the 3.2.4 discipline (an index-served
      // DELETE … WHERE can silently match zero rows).
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM throttle_bucket
           WHERE expiresAt < time::now()
             AND (blockedUntil IS NONE OR blockedUntil < time::now())
           LIMIT 5000`,
      );
      if (ids.length === 0) return 0;
      await db.query(`DELETE $ids`, { ids });
      return ids.length;
    });
  }

  private localIncrement(hit: Hit): Promise<StorageRecord> {
    return this.local.increment(hit.key, hit.ttl, hit.limit, hit.blockDuration, hit.throttlerName);
  }

  private async sharedIncrement(hit: Hit): Promise<StorageRecord> {
    const { key, ttl, limit, blockDuration, throttlerName } = hit;
    const now = Date.now();
    const windowEnd = new Date(now + ttl).toISOString();
    const blockEnd = new Date(now + blockDuration).toISOString();
    const row = await retryOnUniqueViolation(() =>
      this.surreal!.withAdminDb((db) =>
        runTransaction<BucketRow>(db, (tx) => {
          tx.bind('id', `${throttlerName}:${key}`)
            .bind('key', key)
            .bind('name', throttlerName)
            .bind('limit', limit)
            .bind('windowEnd', windowEnd)
            .bind('blockEnd', blockEnd)
            // Point read by record id — a WHERE scan would drag the whole
            // table into the read-set and abort every concurrent hit.
            .add(`LET $row = (SELECT * FROM type::record('throttle_bucket', $id))[0]`)
            .add(`LET $now = time::now()`)
            .add(
              `LET $blockExpired = $row IS NOT NONE AND $row.blockedUntil IS NOT NONE
                 AND $row.blockedUntil <= $now`,
            )
            .add(`LET $fresh = $row IS NONE OR $row.expiresAt <= $now OR $blockExpired`)
            .add(
              `LET $blocked = !$fresh AND $row.blockedUntil IS NOT NONE
                 AND $row.blockedUntil > $now`,
            )
            .add(
              `LET $hits = IF $fresh { 1 } ELSE IF $blocked { $row.hits } ELSE { $row.hits + 1 }`,
            )
            .add(
              `LET $expiresAt = IF $fresh { type::datetime($windowEnd) } ELSE { $row.expiresAt }`,
            )
            .add(
              `LET $blockedUntil = IF $blocked { $row.blockedUntil }
                 ELSE IF $hits > $limit { type::datetime($blockEnd) }
                 ELSE { NONE }`,
            )
            .add(
              `UPSERT type::record('throttle_bucket', $id) CONTENT {
                 key: $key, throttler: $name, hits: $hits,
                 expiresAt: $expiresAt, blockedUntil: $blockedUntil
               }`,
            )
            .add(`RETURN { hits: $hits, expiresAt: $expiresAt, blockedUntil: $blockedUntil }`);
        }),
      ),
    );
    if (!row || typeof row.hits !== 'number') {
      throw new Error('throttle_bucket transaction returned no row');
    }
    const after = Date.now();
    const expiresAt = new Date(row.expiresAt).getTime();
    const blockedUntil = row.blockedUntil ? new Date(row.blockedUntil).getTime() : 0;
    const isBlocked = blockedUntil > after;
    return {
      totalHits: row.hits,
      timeToExpire: Math.max(0, Math.ceil((expiresAt - after) / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil((blockedUntil - after) / 1000) : 0,
    };
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastGcAt < GC_INTERVAL_MS) return;
    this.lastGcAt = now;
    void this.sweepExpired()
      .then((n) => {
        if (n > 0) this.logger.debug(`Swept ${n} expired throttle bucket(s)`);
      })
      .catch((e) => this.logger.warn(`throttle_bucket sweep failed: ${(e as Error).message}`));
  }

  private noteFailure(e: Error): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLogAt = now;
    this.logger.warn(
      `Shared throttle storage unavailable (${e.message}) — counting hits per process until it recovers`,
    );
  }
}
