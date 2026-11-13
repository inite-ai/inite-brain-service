import { Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import type { MigrationLock } from './migration-lock';
import { LeaseHeartbeat } from './lease-heartbeat';
import { enrichTransactionError, isReadConflict, isUniqueViolation } from './surreal-retry';
import { migrationChecksum, recordMigrationDrift } from './migration-checksum';
import { MigrationApplyError } from './migration-blocked';

export { MigrationApplyError };

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
  /** migration-checksum.ts — recorded on apply, validated on every later run. */
  checksum: string;
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
  /**
   * The database `conn` points at, as `namespace/database`. Checksum
   * validation runs once per target; without it the migrator asks the
   * session (`session::ns()`/`session::db()`).
   */
  target?: string;
}

/** Tunables, injected by tests; production takes the defaults. */
export interface MigratorTiming {
  lockTtlSeconds?: number;
  lockWaitMs?: number;
  /** Lease renewal period while a run holds the lock (default: a third of the TTL). */
  heartbeatMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Lease TTL for the migration lock. A cold apply of the whole manifest
 * measures under 4s against SurrealDB 3.2.4, so 30s leaves an order of
 * magnitude of headroom while bounding how long a hard-killed holder can
 * block the rest of the fleet. The holder renews on a heartbeat timer
 * (lease-heartbeat.ts) every third of the TTL WHILE a file runs, not only
 * between files — so one data leg longer than the TTL keeps the lease, and
 * a renewal that fails stops the run at the next file boundary.
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
DEFINE FIELD IF NOT EXISTS checksum    ON schema_migrations TYPE option<string>;
DEFINE INDEX IF NOT EXISTS schema_migrations_id_idx ON schema_migrations FIELDS migrationId UNIQUE;
`;

const FILE_NAME = /^(\d{4})_.+\.surql$/;

/**
 * A connection plus the database it points at — the checksum-validation
 * key. Resolved lazily (first validation check) when the caller passed none.
 */
interface LedgerTarget {
  conn: Surreal;
  key?: string | undefined;
}

/**
 * The `DEFINE ANALYZER IF NOT EXISTS …;` statements of a migration file, in
 * order (see SchemaMigrator.defineAnalyzersFirst). Comments are dropped
 * first so a `;` inside one cannot cut a statement short; an analyzer
 * definition holds no string literal, so `--` is never data there.
 */
export function analyzerDefinitions(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, '');
  return (code.match(/\bDEFINE\s+ANALYZER\s+IF\s+NOT\s+EXISTS\b[^;]*;/gi) ?? []).map((s) =>
    s.replace(/\s+/g, ' ').trim(),
  );
}

interface LedgerRow {
  id: unknown;
  migrationId: string;
  checksum?: string | null;
}

export class SchemaMigrator {
  private readonly logger = new Logger(SchemaMigrator.name);
  private cached: Migration[] | null = null;
  /**
   * Databases (`namespace/database`) whose ledger checksums were validated —
   * once per database per process, not per request. Keyed by database and
   * NOT by connection: SurrealService migrates every tenant through ONE
   * dedicated connection, so a per-connection mark validated only the first
   * database a process touched and never looked at the rest.
   */
  private readonly validated = new Set<string>();
  /** Fallback target keys for connections whose session cannot name its database. */
  private readonly anonymousTargets = new WeakMap<Surreal, string>();
  private readonly lockTtlSeconds: number;
  private readonly lockWaitMs: number;
  private readonly heartbeatMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly migrationsDir: string,
    timing: MigratorTiming = {},
  ) {
    this.lockTtlSeconds = timing.lockTtlSeconds ?? LOCK_TTL_SECONDS;
    this.lockWaitMs = timing.lockWaitMs ?? LOCK_WAIT_MS;
    this.heartbeatMs = timing.heartbeatMs ?? (this.lockTtlSeconds * 1000) / 3;
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
    const target: LedgerTarget = { conn, key: opts.target };
    const upToDate = await this.readLedger(target);
    if (upToDate.pending.length === 0) return upToDate.result;
    if (!lock || !lockName) return this.applyPending(target);

    if (!(await this.acquireOrWait(lock, lockName, target))) {
      // The holder finished what we were waiting for: nothing left to do.
      return (await this.readLedger(target)).result;
    }
    const heartbeat = new LeaseHeartbeat(
      { lock, name: lockName, ttlSeconds: this.lockTtlSeconds },
      this.heartbeatMs,
    );
    heartbeat.start();
    try {
      return await this.applyPending(target, heartbeat);
    } finally {
      await heartbeat.stop();
      await lock.release(lockName);
    }
  }

  /**
   * `namespace/database` the connection's session points at, for callers
   * that did not pass `target`. A session that cannot say (a stub, an old
   * server) gets a key private to that connection — the old behaviour,
   * never worse.
   */
  private async sessionTarget(conn: Surreal): Promise<string> {
    try {
      const [pair] = await conn.query<[unknown]>(`RETURN [session::ns(), session::db()]`);
      if (Array.isArray(pair) && pair.every((p) => typeof p === 'string') && pair.length === 2) {
        return `${pair[0] as string}/${pair[1] as string}`;
      }
    } catch {
      // fall through to the per-connection key
    }
    let key = this.anonymousTargets.get(conn);
    if (!key) {
      key = `conn#${Math.random().toString(36).slice(2)}`;
      this.anonymousTargets.set(conn, key);
    }
    return key;
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
  private async acquireOrWait(
    lock: MigrationLock,
    name: string,
    target: LedgerTarget,
  ): Promise<boolean> {
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
      if ((await this.readLedger(target)).pending.length === 0) {
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
    target: LedgerTarget,
  ): Promise<{ pending: Migration[]; result: MigrationResult }> {
    const { conn } = target;
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
    const rows = await this.fetchLedger(conn);
    const applied = new Set(rows.map((r) => r.migrationId));
    const key = (target.key ??= await this.sessionTarget(conn));
    if (!this.validated.has(key)) {
      this.validated.add(key);
      await this.validateChecksums(conn, manifest, rows);
    }
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
    target: LedgerTarget,
    heartbeat?: LeaseHeartbeat,
  ): Promise<MigrationResult> {
    const { pending, result } = await this.readLedger(target);
    if (pending.length === 0) return result;
    const applied = result.alreadyApplied;

    for (const m of pending) {
      // The heartbeat renews while a file runs; a loss it saw stops the run
      // here, before the next file, never in the middle of one.
      heartbeat?.assertHeld(m.name);
      await this.applyOne(target.conn, m);
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
    await this.defineAnalyzersFirst(conn, m);
    const batch =
      `BEGIN TRANSACTION;\n${m.sql}\n` +
      `CREATE schema_migrations CONTENT { migrationId: $mig_id, name: $mig_name, checksum: $mig_sum };\n` +
      `COMMIT TRANSACTION;`;
    let attempts = 0;
    const maxAttempts = 5;
    for (;;) {
      try {
        await conn.query(batch, { mig_id: m.id, mig_name: m.name, mig_sum: m.checksum });
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
          throw new MigrationApplyError(m.id, m.name, err);
        }
        const baseMs = 20 * Math.pow(2, attempts - 1);
        await this.sleep(baseMs + Math.random() * baseMs);
      }
    }
  }

  /**
   * Commit the file's `DEFINE ANALYZER IF NOT EXISTS` statements before the
   * file's own transaction. SurrealDB 3.2.4 builds a FULLTEXT index over the
   * rows a table already holds right in `DEFINE INDEX`, and that build looks
   * the analyzer up in the COMMITTED catalogue: an analyzer defined earlier
   * in the same transaction is invisible to it ("The analyzer 'x' does not
   * exist"). On an empty table nothing is built and the file passes, which
   * is why 0184 applied on every fresh database and on empty prod tenants
   * and failed on every tenant with a fact or a turn (incident 2026-11-13,
   * test/migration-populated-tenant.e2e-spec.ts). The statements stay in the
   * file's batch too, where IF NOT EXISTS makes them no-ops. An analyzer is
   * inert on its own, so one left behind by a file that then fails changes
   * nothing, and the retry defines it again as a no-op.
   */
  private async defineAnalyzersFirst(conn: Surreal, m: Migration): Promise<void> {
    const analyzers = analyzerDefinitions(m.sql);
    if (analyzers.length === 0) return;
    try {
      await conn.query(`BEGIN TRANSACTION;\n${analyzers.join('\n')}\nCOMMIT TRANSACTION;`);
    } catch (err) {
      // Not fatal: an analyzer that leans on something the file defines
      // later (a function) cannot go first; the file's own batch still
      // defines it in order and is the one whose outcome counts.
      this.logger.warn(
        `Migration ${m.name}: analyzers could not be committed ahead of the file: ` +
          (err as Error).message,
      );
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
        const sql = await readFile(join(this.migrationsDir, name), 'utf-8');
        return { id, name, sql, checksum: migrationChecksum(sql) };
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
    return (await this.fetchLedger(conn)).map((r) => r.migrationId);
  }

  private async fetchLedger(conn: Surreal): Promise<LedgerRow[]> {
    const [rows] = await conn.query<[LedgerRow[]]>(
      `SELECT id, migrationId, checksum FROM schema_migrations`,
    );
    return rows ?? [];
  }

  /**
   * Applied migrations against the files: a row without a checksum (applied
   * before checksums were recorded) takes the current file's, once — trust
   * on first use; a row whose checksum differs is drift, logged by id and
   * counted, never applied and never fatal. A failure here is only logged:
   * validation must not turn a healthy boot into an outage.
   */
  private async validateChecksums(
    conn: Surreal,
    manifest: Migration[],
    rows: LedgerRow[],
  ): Promise<void> {
    const byId = new Map(manifest.map((m) => [m.id, m]));
    try {
      for (const row of rows) {
        const file = byId.get(row.migrationId);
        if (!file) continue;
        if (row.checksum === undefined || row.checksum === null) {
          await conn.query(`UPDATE $row SET checksum = $sum`, { row: row.id, sum: file.checksum });
        } else if (row.checksum !== file.checksum) {
          recordMigrationDrift(row.migrationId);
          this.logger.error(
            `Migration ${file.name} differs from the one this database applied — an edited ` +
              `shipped migration never runs again; ship the change as a new migration`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Migration checksum validation skipped: ${(err as Error).message}`);
    }
  }
}
