/**
 * Databases whose schema does not apply, and at which migration. A tenant
 * whose next migration fails is refused by every path that opens it
 * (`SurrealService.ensureSchema` runs before each pooled connection): its
 * reads, its writes and every background job — the worker's claim loop only
 * logs a warning per tick. On 2026-11-13 that held four tenants for hours
 * behind 0184 with the service healthy; this ledger is what the
 * `brain_migration_blocked` gauge and the MigrationBlocked alert read.
 * A later successful apply clears the database.
 */
const blocked = new Map<string, string>();

export function recordMigrationBlocked(database: string, migrationId: string): void {
  blocked.set(database, migrationId);
}

export function clearMigrationBlocked(database: string): void {
  blocked.delete(database);
}

/** Blocked databases per migration id. */
export function migrationBlockedSnapshot(): ReadonlyMap<string, number> {
  const byMigration = new Map<string, number>();
  for (const id of blocked.values()) byMigration.set(id, (byMigration.get(id) ?? 0) + 1);
  return byMigration;
}

/** A migration file that did not apply — carries its id for the ledger above. */
export class MigrationApplyError extends Error {
  constructor(
    readonly migrationId: string,
    name: string,
    cause: unknown,
  ) {
    super(`Migration ${name} failed: ${(cause as Error).message}`);
    this.name = 'MigrationApplyError';
  }
}
