import { Injectable, Logger, Optional } from '@nestjs/common';
import { PROCESS_IDENTITY } from '../common/process-identity';
import {
  SurrealService,
  runTransaction,
  retryOnUniqueViolation,
  queryRows,
  queryFirst,
} from '../db/surreal.service';

/** SurrealDB returns datetimes as a Date on 3.x and an ISO string via JSON. */
type RawDateTime = string | number | Date;

/** Raw leader_lease row for the read-only /admin/maintenance view. */
interface LeaseRow {
  name: string;
  leaderId: string;
  leaseUntil: RawDateTime;
  heartbeatAt: RawDateTime;
  acquiredAt: RawDateTime;
}

/** Point-read projection behind isHeld(). */
interface HeldRow {
  leaderId: string;
  leaseUntil: RawDateTime;
  epoch?: number | bigint;
}

/**
 * Acquire / renew / release named leases in `leader_lease` (migration
 * 0029). Replaces process-local InFlightGuard for cron methods on
 * multi-pod deploys: only the leaseholder pod runs the body.
 *
 * Pattern: UPSERT inside a single BEGIN/COMMIT — SurrealDB's SSI +
 * OCC catches racing pods at commit, retryOnUniqueViolation absorbs
 * the abort. The aspirant either wins (rows returned with our
 * leaderId) or sees a still-valid lease (we back off).
 *
 * Every lease carries an `epoch` (migration 0142): the number of fresh
 * acquisitions of that name. It goes up when the holder changes or the row
 * was missing, and stays put while the same holder renews, so work done
 * under a lease can be stamped with the epoch and refused once a later
 * holder exists — the holder identity alone cannot say WHEN it was taken,
 * which is what a lost lease table (a restart on a non-durable volume, an
 * operator deleting rows) otherwise hides.
 *
 * Defaults: ttl=90s (long enough to survive GC pauses, short enough
 * that a crashed leader's lease expires before the next cron fires).
 * Heartbeat optional — short cron jobs just acquire-then-release, no
 * mid-flight renew needed.
 */
@Injectable()
export class LeaderLeaseService {
  private readonly logger = new Logger(LeaderLeaseService.name);
  private readonly leaderId: string = PROCESS_IDENTITY;

  constructor(@Optional() private readonly surreal?: SurrealService) {}

  identity(): string {
    return this.leaderId;
  }

  /**
   * Try to acquire `name` for `ttlSeconds`. Returns true if we hold
   * it after the call, false if another pod does.
   */
  async tryAcquire(name: string, ttlSeconds = 90): Promise<boolean> {
    return (await this.acquire(name, ttlSeconds)) !== null;
  }

  /**
   * tryAcquire that also returns the lease's fencing epoch, or null when
   * another pod holds the lease. Without a datastore (dev / unit tests) the
   * lease is always ours, at epoch 0.
   */
  async acquire(name: string, ttlSeconds = 90): Promise<number | null> {
    if (!this.surreal) return 0; // dev / unit tests — single process
    try {
      // Deadline computed in JS and bound as an ISO string: the
      // duration::from_* / duration::from::* function paths differ
      // between SurrealDB 2.x and 3.x (prod hit a parse error on the
      // 3.x spelling), while type::datetime($iso) parses on both.
      const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const out = await retryOnUniqueViolation(() =>
        this.surreal!.withAdminDb((db) =>
          runTransaction<unknown>(db, (tx) => {
            tx.bind('name', name)
              .bind('me', this.leaderId)
              .bind('until', until)
              // Point-read on the record id (id IS the lease name — see
              // migration 0029), NOT a `WHERE name = $name` table scan.
              // Under SSI a scan puts the WHOLE table in the read-set, so
              // any two concurrent acquires — even for different lease
              // names (worker_loop every 30s vs lease_manager_cron every
              // 10s) — mutually abort with read-write conflicts. Prod sat
              // in a permanent conflict storm until this was narrowed.
              //
              // SINGLE-arg type::record('table:id') deliberately: the
              // 2-arg form means "construct id" on SurrealDB 3.x but
              // "cast arg1 into record<arg2>" on 2.x, where it fails at
              // eval time ("cannot convert 'leader_lease' into a
              // record<worker_loop>"). The string-compose form parses
              // and constructs on both generations; lease names are
              // code-controlled [a-z_]+ so no id-escaping concerns.
              .add(`LET $row = (SELECT * FROM type::record('leader_lease:' + $name))[0]`)
              // A missing row, a lapsed lease, or our own lease is ours to
              // take; only a change of holder (or a missing row) bumps the
              // epoch, so a renew by the same holder keeps its token.
              .add(
                `IF $row IS NONE OR $row.leaseUntil < time::now() OR $row.leaderId = $me {
                   LET $epoch = IF $row.leaderId = $me { $row.epoch OR 0 } ELSE { ($row.epoch OR 0) + 1 };
                   UPSERT type::record('leader_lease:' + $name) CONTENT {
                     name: $name,
                     leaderId: $me,
                     leaseUntil: type::datetime($until),
                     heartbeatAt: time::now(),
                     acquiredAt: $row.acquiredAt OR time::now(),
                     epoch: $epoch
                   };
                   RETURN $epoch;
                 } ELSE {
                   RETURN NONE;
                 }`,
              );
          }),
        ),
      );
      return typeof out === 'number' || typeof out === 'bigint' ? Number(out) : null;
    } catch (e) {
      this.logger.warn(`acquire(${name}) failed: ${(e as Error).message}; treating as not-leader`);
      return null;
    }
  }

  /**
   * Point read: does this process hold `name` right now — our leaderId,
   * not expired, and (when given) still at the epoch it was acquired
   * under. A failed read answers false: not knowing is not holding.
   */
  async isHeld(name: string, epoch?: number): Promise<boolean> {
    if (!this.surreal) return true; // dev / unit tests — single process
    try {
      return await this.surreal.withAdminDb(async (db) => {
        // Point read on the record id, same reason acquire() point-reads.
        const row = await queryFirst<HeldRow>(
          db,
          `SELECT leaderId, leaseUntil, epoch FROM type::record('leader_lease:' + $name)`,
          { name },
        );
        if (!row || row.leaderId !== this.leaderId) return false;
        if (new Date(row.leaseUntil).getTime() <= Date.now()) return false;
        return epoch === undefined || Number(row.epoch ?? 0) === epoch;
      });
    } catch (e) {
      this.logger.warn(`isHeld(${name}) failed: ${(e as Error).message}; treating as not held`);
      return false;
    }
  }

  /**
   * Release the lease if we still hold it. Idempotent: deleting a
   * lease owned by someone else is a no-op.
   */
  async release(name: string): Promise<void> {
    if (!this.surreal) return;
    try {
      await this.surreal.withAdminDb(async (db) => {
        // Point-delete on the record id for the same reason tryAcquire
        // point-reads: a WHERE-name scan drags the whole table into the
        // transaction's read-set and aborts concurrent acquires.
        // Single-arg type::record — see tryAcquire for why.
        await db.query(`DELETE type::record('leader_lease:' + $name) WHERE leaderId = $me`, {
          name,
          me: this.leaderId,
        });
      });
    } catch (e) {
      this.logger.warn(`release(${name}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * Read-only view for /admin/maintenance — who holds what right now.
   */
  async list(): Promise<
    Array<{
      name: string;
      leaderId: string;
      leaseUntil: string;
      heartbeatAt: string;
      acquiredAt: string;
    }>
  > {
    if (!this.surreal) return [];
    try {
      return await this.surreal.withAdminDb(async (db) => {
        const rows = await queryRows<LeaseRow>(
          db,
          `SELECT name, leaderId, leaseUntil, heartbeatAt, acquiredAt FROM leader_lease`,
        );
        return rows.map((r) => ({
          name: r.name,
          leaderId: r.leaderId,
          leaseUntil: new Date(r.leaseUntil).toISOString(),
          heartbeatAt: new Date(r.heartbeatAt).toISOString(),
          acquiredAt: new Date(r.acquiredAt).toISOString(),
        }));
      });
    } catch {
      return [];
    }
  }
}
