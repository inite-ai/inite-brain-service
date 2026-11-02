import { createHash } from 'node:crypto';

/**
 * Migration checksums (Flyway / Liquibase `validate`). Ground rule 1 forbids
 * editing a shipped migration because the migrator records applied ids per
 * tenant and skips a file it has seen — an edit never reaches a database
 * that already ran the file, and nothing said so. A content hash is
 * recorded beside each applied id; a later file whose hash differs from the
 * recorded one is drift: reported (id only), never applied, never a reason
 * to refuse boot — the CI guard (test/migration-checksums.unit-spec.ts) is
 * what keeps an edit from merging in the first place.
 */

/** sha256 of the file with line endings normalised, so a checkout's CRLF is not drift. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n')).digest('hex');
}

/** Tenants seen with drift, per migration id, since boot — read by the metrics gauge. */
const drift = new Map<string, number>();

export function recordMigrationDrift(migrationId: string): void {
  drift.set(migrationId, (drift.get(migrationId) ?? 0) + 1);
}

export function migrationDriftSnapshot(): ReadonlyMap<string, number> {
  return drift;
}
