import { Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import type { MigrationLock } from './migration-lock';
import { enrichTransactionError, isReadConflict, isUniqueViolation } from './surreal-retry';

/**
 * Schema migrator — versioned, append-only DDL applied per tenant DB.
 *
 * Why migrations and not "apply schema.surql at boot":
 *   - Breaking changes: a `DEFINE FIELD ... TYPE int` that used to be
 *     `option<int>` is fine on a fresh DB but rejects existing rows on
 *     an old tenant. We need to be able to ship that change behind a
 *     numbered file and re-apply only on tenants that haven't seen it.
 *   - Auditing: ops needs to answer "which version of the schema is
 *     this tenant on?" Today the answer is a guess. With migrations,
 *     it's a SELECT.
 *   - Reproducibility: replay a tenant from event log on a fresh DB
 *     and you should converge on the same schema. Numbered migrations
 *     are how every migration tool from Rails on does that.
 *
 * Layout:
 *   - src/db/migrations/NNNN_description.surql — applied in numeric order
 *   - schema_migrations table tracks what was applied (migrationId, name,
 *     appliedAt). The bootstrap DDL for that table is the only thing we
 *     run unconditionally.
 *
 * Concurrency: SurrealService's schema queue only serializes appliers
 * inside ONE process. Across replicas (N pods booting at once, or two
 * images overlapping during a rolling deploy) the arbiter is the
 * distributed lock passed in `MigrateOptions` — keyed per target
 * database, so tenants still migrate in parallel. A replica that loses
 * the race waits for the holder and then re-reads the ledger, so it
 * applies only what is genuinely left, and each file lands together with
 * its ledger row in one BEGIN/COMMIT.
 */

export interface Migration {
  id: string; // "0001"
  name: string; // "0001_baseline.surql"
  sql: string;
}

export interface MigrationResult {
  applied: string[]; // migration IDs newly applied this run
  alreadyApplied: string[]; // migration IDs already present
}

export interface MigrateOptions {
  /**
   * Cross-replica lock. Production always passes one; unit tests and
   * one-shot scripts driving a database nobody else touches may omit it,
   * in which case the only arbitration left is the in-process queue.
   */
  lock?: MigrationLock;
  /** Lease name for `lock` — see `migrationLeaseName`. */
  lockName?: string;
}

/** Tunables, injected by tests; production takes the defaults. */
export interface MigratorTiming {
  lockTtlSeconds?: number;
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Lease TTL for the migration lock. A cold apply of the whole manifest
 * measures under 4s against SurrealDB 3.2.4, so 30s leaves an order of
 * magnitude of headroom while bounding how long a hard-killed holder can
 * block the rest of the fleet; the holder renews at half-life anyway, so
 * a slow data leg does not lose the lock.
 */
const LOCK_TTL_SECONDS = 30;

/**
 * How long a replica that lost the race waits for the holder before it
 * gives up. Longer than the TTL, so a crashed holder is always taken over
 * rather than waited out forever, and short enough that a stuck lease
 * cannot hold a caller's pooled connection for minutes. The wait ends
 * early — and never throws — as soon as the ledger says the work is done.
 */
const LOCK_WAIT_MS = 60_000;

const SCHEMA_MIGRATIONS_DDL = `
DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS migrationId ON schema_migrations TYPE string;
DEFINE FIELD IF NOT EXISTS name        ON schema_migrations TYPE string;
DEFINE FIELD IF NOT EXISTS appliedAt   ON schema_migrations TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS schema_migrations_id_idx ON schema_migrations FIELDS migrationId UNIQUE;
`;

const FILE_NAME = /^(\d{4})_.+\.surql$/;

export class SchemaMigrator {
  private readonly logger = new Logger(SchemaMigrator.name);
  private cached: Migration[] | null = null;
  private readonly lockTtlSeconds: number;
  private readonly lockWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly migrationsDir: string,
    timing: MigratorTiming = {},
  ) {
    this.lockTtlSeconds = timing.lockTtlSeconds ?? LOCK_TTL_SECONDS;
    this.lockWaitMs = timing.lockWaitMs ?? LOCK_WAIT_MS;
    this.sleep = timing.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Apply all pending migrations against `conn`, holding `opts.lock` for
   * the whole run so replicas booting together apply the manifest once.
   *
   * The ledger is read BEFORE the lease is touched. A database whose
   * manifest is already complete needs no arbitration — that is every
   * request after the first one for that tenant, and every boot of a
   * tenant some other replica already migrated — and it must not pay a
   * cross-replica round trip, let alone wait behind a lease a dead holder
   * left, while the caller sits on a pooled connection.
   */
  async migrate(conn: Surreal, opts: MigrateOptions = {}): Promise<MigrationResult> {
    const { lock, lockName } = opts;
    const upToDate = await this.readLedger(conn);
    if (upToDate.pending.length === 0) return upToDate.result;
    if (!lock || !lockName) return this.applyPending(conn);

    if (!(await this.acquireOrWait(lock, lockName, conn))) {
      // The holder finished what we were waiting for: nothing left to do.
      return (await this.readLedger(conn)).result;
    }
    try {
      return await this.applyPending(conn, lock, lockName);
    } finally {
      await lock.release(lockName);
    }
  }

  /**
   * Take the lock, or wait for whoever holds it.
   *
   * Losing the race is not a reason to apply anything: we wait until the
   * holder releases — or until its lease expires, which is how a crashed
   * holder is taken over. Returns false when the wait ended because the
   * work itself is gone (the holder committed the last pending file), so
   * the caller can proceed without ever owning the lease. Transient
   * acquire failures are absorbed inside the same deadline, and the
   * deadline only throws if there is still schema missing — a lease store
   * we cannot reach must never turn a request against an already-migrated
   * database into a 500.
   */
  private async acquireOrWait(lock: MigrationLock, name: string, conn: Surreal): Promise<boolean> {
    const deadline = Date.now() + this.lockWaitMs;
    let delayMs = 50;
    let lastErr: unknown;
    let waited = false;
    for (;;) {
      try {
        if (await lock.tryAcquire(name, this.lockTtlSeconds)) {
          if (waited) this.logger.log(`Took migration lock ${name} after waiting for the holder`);
          return true;
        }
        lastErr = undefined;
      } catch (err) {
        lastErr = err;
      }
      waited = true;
      // Whoever holds it may have finished while we backed off, and an
      // unreachable lease store is only fatal if schema is still missing.
      if ((await this.readLedger(conn)).pending.length === 0) {
        this.logger.log(`Migration lock ${name} not needed — the manifest is already complete`);
        return false;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const why = lastErr
          ? `: ${(lastErr as Error).message}`
          : ' — another replica is still applying schema';
        throw new Error(
          `Timed out after ${this.lockWaitMs}ms waiting for migration lock ${name}${why}`,
        );
      }
      await this.sleep(Math.min(delayMs, left));
      delayMs = Math.min(delayMs * 2, 2000);
    }
  }

  /**
   * Bootstrap the ledger table and read it. Racing replicas abort each
   * other on the guarded DDL, so the read conflict is retried rather than
   * surfaced — this runs before any lease is held, by construction.
   */
  private async readLedger(
    conn: Surreal,
  ): Promise<{ pending: Migration[]; result: MigrationResult }> {
    const manifest = await this.loadManifest();
    let attempts = 0;
    for (;;) {
      try {
        await conn.query(SCHEMA_MIGRATIONS_DDL);
        break;
      } catch (err) {
        if (!isReadConflict(enrichTransactionError(err)) || ++attempts >= 5) throw err;
        await this.sleep(20 * Math.pow(2, attempts - 1));
      }
    }
    const applied = new Set(await this.fetchAppliedIds(conn));
    const pending = manifest.filter((m) => !applied.has(m.id));
    return {
      pending,
      result: {
        applied: [],
        alreadyApplied: pending.length === 0 ? manifest.map((m) => m.id) : [...applied],
      },
    };
  }

  private async applyPending(
    conn: Surreal,
    lock?: MigrationLock,
    lockName?: string,
  ): Promise<MigrationResult> {
    const { pending, result } = await this.readLedger(conn);
    if (pending.length === 0) return result;
    const applied = result.alreadyApplied;

    let renewAt = Date.now() + (this.lockTtlSeconds * 1000) / 2;
    for (const m of pending) {
      if (lock && lockName && Date.now() >= renewAt) {
        if (!(await lock.tryAcquire(lockName, this.lockTtlSeconds))) {
          throw new Error(
            `Lost migration lock ${lockName} before applying ${m.name} — another replica ` +
              `took over; refusing to write schema behind its back`,
          );
        }
        renewAt = Date.now() + (this.lockTtlSeconds * 1000) / 2;
      }
      await this.applyOne(conn, m);
    }

    return {
      applied: pending.map((m) => m.id),
      alreadyApplied: applied,
    };
  }

  /**
   * Apply one file and write its ledger row in ONE BEGIN/COMMIT batch, so
   * a crash mid-file leaves everything or nothing. SurrealDB 3.2.4 rolls
   * DDL back with the transaction and every file in the manifest tolerates
   * the wrapper; a plain multi-statement batch would NOT do, because it
   * keeps executing after a failed statement and would record a
   * half-applied file as done (both measured in
   * migration-concurrency.e2e-spec).
   */
  private async applyOne(conn: Surreal, m: Migration): Promise<void> {
    this.logger.log(`Applying ${m.name}`);
    const batch =
      `BEGIN TRANSACTION;\n${m.sql}\n` +
      `CREATE schema_migrations CONTENT { migrationId: $mig_id, name: $mig_name };\n` +
      `COMMIT TRANSACTION;`;
    let attempts = 0;
    const maxAttempts = 5;
    for (;;) {
      try {
        await conn.query(batch, { mig_id: m.id, mig_name: m.name });
        return;
      } catch (err) {
        // An aborted batch surfaces as one bare "failed transaction"
        // wrapper whether the cause was an OCC conflict on NS-level
        // metadata (0005's DEFINE USER, 0003/0006's functions) or the
        // ledger's unique index. Settle the ambiguity by re-reading: if
        // the row is there, an applier that raced us — only possible when
        // a lease expired under a live holder — already applied identical
        // DDL, so this is not a failure.
        if (await this.isRecorded(conn, m.id)) {
          this.logger.log(`Ledger row for ${m.name} already written by a concurrent applier`);
          return;
        }
        attempts++;
        const retriable = isReadConflict(enrichTransactionError(err)) || isUniqueViolation(err);
        if (!retriable || attempts >= maxAttempts) {
          this.logger.error(
            `Migration ${m.name} failed after ${attempts} attempt(s): ${(err as Error).message}`,
          );
          throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
        }
        const baseMs = 20 * Math.pow(2, attempts - 1);
        await this.sleep(baseMs + Math.random() * baseMs);
      }
    }
  }

  /**
   * Whether the ledger already carries `id`. Reads the whole ledger and
   * filters in JS rather than `WHERE migrationId = $id`: the 3.2.4
   * planner has bitten us on indexed-field predicates, and the table
   * holds one row per migration.
   */
  private async isRecorded(conn: Surreal, id: string): Promise<boolean> {
    try {
      return (await this.fetchAppliedIds(conn)).includes(id);
    } catch {
      return false;
    }
  }

  /** Load + cache migrations from disk. */
  async loadManifest(): Promise<Migration[]> {
    if (this.cached) return this.cached;
    const files = await readdir(this.migrationsDir);
    const eligible = files.filter((f) => FILE_NAME.test(f)).sort();
    if (eligible.length === 0) {
      throw new Error(
        `No migration files found in ${this.migrationsDir}. Expected NNNN_description.surql`,
      );
    }
    const manifest: Migration[] = await Promise.all(
      eligible.map(async (name) => {
        const id = name.match(FILE_NAME)?.[1];
        if (id === undefined) {
          // Unreachable: `eligible` was filtered by FILE_NAME.test above.
          throw new Error(`Migration file ${name} lacks an NNNN id prefix`);
        }
        return {
          id,
          name,
          sql: await readFile(join(this.migrationsDir, name), 'utf-8'),
        };
      }),
    );
    // Reject duplicate IDs early — easier to debug than mid-apply.
    const ids = new Set<string>();
    for (const m of manifest) {
      if (ids.has(m.id)) {
        throw new Error(`Duplicate migration id ${m.id} in ${this.migrationsDir}`);
      }
      ids.add(m.id);
    }
    this.cached = manifest;
    return manifest;
  }

  private async fetchAppliedIds(conn: Surreal): Promise<string[]> {
    const [rows] = await conn.query<[Array<{ migrationId: string }>]>(
      `SELECT migrationId FROM schema_migrations`,
    );
    return ((rows ?? []) as Array<{ migrationId: string }>).map((r) => r.migrationId);
  }
}
