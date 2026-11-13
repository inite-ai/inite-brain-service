import type { Surreal } from 'surrealdb';

/**
 * A data migration: a fix to existing rows, kept out of the schema
 * migrations (src/db/migrations/ are DDL only from 0197 on).
 *
 * Why not an `UPDATE … WHERE …` in a .surql file: on SurrealDB 3.2.4 an
 * UPDATE whose filter is planned through an index on the field it filters
 * is a silent no-op (0178's header), and production proved it twice — 0182
 * left 20 closed edges unchecked, 0164's second backfill left one closed
 * edge without validUntil, both recorded as applied. A schema file also
 * runs on the request path, unbatched, in one transaction per file.
 *
 * A data migration instead counts what is left (`pending`) and fixes a
 * bounded batch at a time by explicit record id (`step`); the background
 * `data_migrations` job (DataMigrationRunnerService) runs every registered
 * one per tenant and marks it done only when a re-count finds nothing left.
 *
 * Registered through Nest DI under DATA_MIGRATIONS (DataMigrationsModule),
 * never a hard-coded list in the runner. A data migration writes no user
 * content — it moves ids, instants and flags the schema already holds — so
 * the GDPR forget cascade has nothing new to cover.
 */
export interface DataMigration {
  /** Stable id: the ledger key (data_migration:⟨id⟩) and the metric label. Never renamed. */
  readonly id: string;
  /** One line for operators: what it fixes and why. */
  readonly description: string;
  /** Rows in this tenant that still need the fix. */
  pending(db: Surreal): Promise<number>;
  /** Fix up to `limit` rows; resolves to how many it fixed. */
  step(db: Surreal, limit: number): Promise<number>;
}

/** Injection token: every registered DataMigration, in registration order. */
export const DATA_MIGRATIONS = Symbol('DATA_MIGRATIONS');
