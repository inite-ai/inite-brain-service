import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Surreal } from 'surrealdb';
import { runTransaction } from './surreal.service';
import { retryOnUniqueViolation } from './surreal-retry';

/**
 * Cross-replica lock the migrator holds while it applies schema.
 *
 * Contract: `tryAcquire` resolves true only if this process owns `name`
 * for the next `ttlSeconds`; calling it again while we own it renews the
 * lease. `release` drops a lease we still own and is idempotent. Both
 * may reject — the caller decides whether to retry or fail closed.
 */
export interface MigrationLock {
  tryAcquire(name: string, ttlSeconds: number): Promise<boolean>;
  release(name: string): Promise<void>;
}

/**
 * 32-bit FNV-1a. A collision guard for a readable slug, NOT a security
 * primitive — deliberately not a crypto digest, because nothing about a
 * lease name needs to resist an adversary.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Lease name for one target database. Lease names are composed into the
 * record id `leader_lease:<name>`, so a `:` or `/` in the name breaks id
 * parsing: everything outside [a-z0-9_] folds to `_`, and a digest of the
 * raw pair is appended so two targets that fold alike cannot collide
 * into one lease.
 */
export function migrationLeaseName(namespace: string, database: string): string {
  const raw = `migrate:${namespace}/${database}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 48);
  return `${slug}_${fnv1a32(raw)}`;
}

/**
 * The `leader_lease` shape from migration 0029, repeated here as
 * idempotent bootstrap DDL. The lease table lives in the admin database,
 * which is itself migrated, so the lock cannot wait for 0029 to have
 * run — it defines the table it needs first. `IF NOT EXISTS` keeps this
 * a no-op once 0029 lands, and keeps the row shape identical to what
 * LeaderLeaseService reads and writes.
 */
const LEASE_TABLE_DDL = `
DEFINE TABLE IF NOT EXISTS leader_lease SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name        ON leader_lease TYPE string;
DEFINE FIELD IF NOT EXISTS leaderId    ON leader_lease TYPE string;
DEFINE FIELD IF NOT EXISTS leaseUntil  ON leader_lease TYPE datetime;
DEFINE FIELD IF NOT EXISTS heartbeatAt ON leader_lease TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS acquiredAt  ON leader_lease TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS note        ON leader_lease TYPE option<string>;
DEFINE INDEX IF NOT EXISTS leader_lease_name_idx ON leader_lease FIELDS name UNIQUE;
`;

/** Runs `fn` against a root connection pointed at the lease database. */
export type WithLeaseDb = <T>(fn: (db: Surreal) => Promise<T>) => Promise<T>;

/**
 * Compare-and-set lock over the same `leader_lease` table (and the same
 * row shape) as LeaderLeaseService, reimplemented here because
 * SurrealService cannot depend on it: LeaderLeaseService injects
 * SurrealService, so the reverse edge is a DI cycle. The CAS is a
 * point-read plus a conditional UPSERT on the record id inside one
 * BEGIN/COMMIT — a `WHERE name = ...` scan would put the whole table in
 * the read-set and make unrelated lease acquires abort each other.
 * Writes use SET rather than CONTENT so fields this module does not know
 * about survive a takeover.
 */
export class SurrealMigrationLock implements MigrationLock {
  private readonly logger = new Logger(SurrealMigrationLock.name);
  private readonly leaderId: string;
  private tableReady = false;

  constructor(
    private readonly withLeaseDb: WithLeaseDb,
    identity?: string,
  ) {
    // Unique per PROCESS, not per host+pid: containers commonly run the
    // app as pid 1, so a restarted replica would otherwise inherit its
    // predecessor's lease and believe it still holds the lock.
    this.leaderId = identity ?? `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;
  }

  identity(): string {
    return this.leaderId;
  }

  async tryAcquire(name: string, ttlSeconds: number): Promise<boolean> {
    // Deadline computed in JS and bound as an ISO string: the
    // duration::from_* spellings differ across SurrealDB generations,
    // type::datetime($iso) parses on both.
    const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return this.withLeaseDb(async (db) => {
      await this.ensureTable(db);
      return retryOnUniqueViolation(async () => {
        const held = await runTransaction<unknown>(db, (tx) => {
          tx.bind('name', name)
            .bind('me', this.leaderId)
            .bind('until', until)
            .add(`LET $row = (SELECT * FROM type::record('leader_lease:' + $name))[0]`)
            .add(
              `IF $row IS NONE OR $row.leaseUntil < time::now() OR $row.leaderId = $me {
                 UPSERT type::record('leader_lease:' + $name) SET
                   name = $name,
                   leaderId = $me,
                   leaseUntil = type::datetime($until),
                   heartbeatAt = time::now(),
                   acquiredAt = $row.acquiredAt OR time::now();
                 RETURN true;
               } ELSE {
                 RETURN false;
               }`,
            );
        });
        return held === true;
      });
    });
  }

  /**
   * Drop the lease if we still own it. Never throws: a failed release
   * only means waiters sit out the TTL instead of starting immediately.
   */
  async release(name: string): Promise<void> {
    try {
      await this.withLeaseDb(async (db) => {
        await db.query(`DELETE type::record('leader_lease:' + $name) WHERE leaderId = $me`, {
          name,
          me: this.leaderId,
        });
      });
    } catch (e) {
      this.logger.warn(`release(${name}) failed: ${(e as Error).message}`);
    }
  }

  private async ensureTable(db: Surreal): Promise<void> {
    if (this.tableReady) return;
    // Two replicas bootstrapping the same DDL abort each other under OCC;
    // the guards make every attempt after the first a no-op.
    await retryOnUniqueViolation(() => db.query(LEASE_TABLE_DDL));
    this.tableReady = true;
  }
}
