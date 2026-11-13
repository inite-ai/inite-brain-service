/**
 * Rows each data migration still has to fix, per tenant, as this process
 * last counted them (DataMigrationRunnerService records after every run).
 * The `brain_data_migration_remaining{migration}` gauge sums it over
 * tenants: no tenant label, so the series count stays bounded by the
 * number of data migrations, not the roster.
 */
const remaining = new Map<string, Map<string, number>>();

export function recordDataMigrationRemaining(
  migrationId: string,
  companyId: string,
  rows: number,
): void {
  let byTenant = remaining.get(migrationId);
  if (!byTenant) {
    byTenant = new Map();
    remaining.set(migrationId, byTenant);
  }
  byTenant.set(companyId, rows);
}

/** Remaining rows per migration id, summed over every tenant this process counted. */
export function dataMigrationRemainingSnapshot(): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [id, byTenant] of remaining) {
    let sum = 0;
    for (const n of byTenant.values()) sum += n;
    out.set(id, sum);
  }
  return out;
}

/** Test seam: forget everything counted. */
export function resetDataMigrationRemaining(): void {
  remaining.clear();
}
