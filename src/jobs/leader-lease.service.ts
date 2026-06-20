import { Injectable, Logger, Optional } from '@nestjs/common';
import { hostname } from 'node:os';
import { SurrealService, runTransaction, retryOnUniqueViolation } from '../db/surreal.service';

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
 * Defaults: ttl=90s (long enough to survive GC pauses, short enough
 * that a crashed leader's lease expires before the next cron fires).
 * Heartbeat optional — short cron jobs just acquire-then-release, no
 * mid-flight renew needed.
 */
@Injectable()
export class LeaderLeaseService {
  private readonly logger = new Logger(LeaderLeaseService.name);
  private readonly leaderId: string;

  constructor(@Optional() private readonly surreal?: SurrealService) {
    this.leaderId = `${hostname()}#${process.pid}`;
  }

  identity(): string {
    return this.leaderId;
  }

  /**
   * Try to acquire `name` for `ttlSeconds`. Returns true if we hold
   * it after the call, false if another pod does.
   */
  async tryAcquire(name: string, ttlSeconds = 90): Promise<boolean> {
    if (!this.surreal) return true; // dev / unit tests — single process
    try {
      return await retryOnUniqueViolation(() =>
        this.surreal!.withAdminDb(async (db) => {
          const out = await runTransaction<unknown>(db, (tx) => {
            tx.bind('name', name)
              .bind('me', this.leaderId)
              .bind('ttl', ttlSeconds)
              .add(
                `LET $row = (SELECT * FROM leader_lease WHERE name = $name LIMIT 1)[0]`,
              )
              .add(
                `IF $row IS NONE OR $row.leaseUntil < time::now() OR $row.leaderId = $me {
                   UPSERT type::thing('leader_lease', $name) CONTENT {
                     name: $name,
                     leaderId: $me,
                     leaseUntil: time::now() + duration::from::secs($ttl),
                     heartbeatAt: time::now(),
                     acquiredAt: $row.acquiredAt OR time::now()
                   };
                   RETURN true;
                 } ELSE {
                   RETURN false;
                 }`,
              );
          });
          return out === true;
        }),
      );
    } catch (e) {
      this.logger.warn(
        `tryAcquire(${name}) failed: ${(e as Error).message}; treating as not-leader`,
      );
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
        await db.query(
          `DELETE FROM leader_lease WHERE name = $name AND leaderId = $me`,
          { name, me: this.leaderId },
        );
      });
    } catch (e) {
      this.logger.warn(
        `release(${name}) failed: ${(e as Error).message}`,
      );
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
        const res = (await db.query<any[]>(
          `SELECT name, leaderId, leaseUntil, heartbeatAt, acquiredAt FROM leader_lease`,
        )) as any[];
        const rows = (res[0] ?? []) as any[];
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
