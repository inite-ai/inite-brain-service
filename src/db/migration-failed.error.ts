/**
 * A migration file that failed to apply. `migrationId` labels
 * `brain_migration_failures_total` (migration-failures.ts) — the id, never
 * the tenant.
 */
export class MigrationFailedError extends Error {
  constructor(
    readonly migrationId: string,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationFailedError';
  }
}
