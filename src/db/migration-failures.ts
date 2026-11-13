import { ServiceUnavailableException } from '@nestjs/common';
import { MigrationApplyError } from './migration-blocked';

/**
 * Per-database backoff after a failed schema apply.
 *
 * Before this, a migration that failed on one tenant left the database
 * unmarked, so EVERY request for that tenant re-entered the global schema
 * queue, re-ran the failing file (up to five attempts for a retriable
 * error) and answered 500 — a broken tenant turned its own traffic into a
 * migration storm and slowed every other tenant's cold start queued behind
 * it. Now a failure opens a cooldown for that database: 30 s, doubling per
 * consecutive failure, capped at 15 min. Inside the window requests fail
 * fast with a 503 that names no tenant; the first request after it retries
 * the apply once; a success clears the record.
 *
 * The ledger below is process-level (like migration-checksum.ts's drift
 * map) so the metrics module can read it at scrape time without a DI edge
 * into SurrealService.
 */

export const MIGRATION_BACKOFF_BASE_MS = 30_000;
export const MIGRATION_BACKOFF_MAX_MS = 15 * 60_000;

/** Failures not attributable to one file (lease wait timed out, connection lost). */
export const UNATTRIBUTED_MIGRATION = 'none';

interface FailureState {
  consecutive: number;
  retryAt: number;
}

/** Failed applies since boot, per migration id — read by the failure counter. */
const failuresByMigration = new Map<string, number>();
/** Databases whose last schema apply failed, across every tracker in the process. */
const failingDatabases = new Set<string>();

export function migrationFailureSnapshot(): {
  failures: ReadonlyMap<string, number>;
  failingDatabases: number;
} {
  return { failures: failuresByMigration, failingDatabases: failingDatabases.size };
}

/** Backoff after `consecutive` failures in a row: 30 s, 60 s, 120 s … capped at 15 min. */
export function migrationBackoffMs(consecutive: number): number {
  const exp = Math.max(0, consecutive - 1);
  return Math.min(MIGRATION_BACKOFF_BASE_MS * 2 ** Math.min(exp, 30), MIGRATION_BACKOFF_MAX_MS);
}

export class MigrationBackoff {
  private readonly state = new Map<string, FailureState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws a 503 while `database` is cooling down after a failed apply. */
  assertNotCoolingDown(database: string): void {
    const s = this.state.get(database);
    if (!s || this.now() >= s.retryAt) return;
    throw new ServiceUnavailableException(
      `Workspace schema migration is failing; retrying in ${Math.ceil(
        (s.retryAt - this.now()) / 1000,
      )}s`,
    );
  }

  /** Record a failed apply; returns the cooldown it opened (ms). */
  recordFailure(database: string, err: unknown): number {
    const migration = err instanceof MigrationApplyError ? err.migrationId : UNATTRIBUTED_MIGRATION;
    failuresByMigration.set(migration, (failuresByMigration.get(migration) ?? 0) + 1);
    failingDatabases.add(database);
    const consecutive = (this.state.get(database)?.consecutive ?? 0) + 1;
    const wait = migrationBackoffMs(consecutive);
    this.state.set(database, { consecutive, retryAt: this.now() + wait });
    return wait;
  }

  recordSuccess(database: string): void {
    this.state.delete(database);
    failingDatabases.delete(database);
  }

  /** Forget a database entirely (it was dropped). */
  forget(database: string): void {
    this.recordSuccess(database);
  }
}
