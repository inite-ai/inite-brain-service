import { Counter, Gauge, type Registry } from 'prom-client';
import { migrationFailureSnapshot } from '../db/migration-failures';

/**
 * Failed schema applies, read at scrape time from the process-level ledger
 * in src/db/migration-failures.ts. Labelled by migration id only — never by
 * tenant: the tenant set is unbounded and a tenant id is not an ops label.
 * `none` counts failures no single file owns (lease wait timed out, the
 * connection dropped mid-apply).
 */
export function migrationFailuresCounter(registry: Registry): Counter<'migration'> {
  return new Counter({
    name: 'brain_migration_failures_total',
    help: 'Failed schema applies since boot, by migration id (none = not attributable to one file)',
    labelNames: ['migration'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [migration, n] of migrationFailureSnapshot().failures) this.inc({ migration }, n);
    },
  });
}

/**
 * Databases (tenants, plus the platform's `system` database) whose last
 * schema apply on this replica failed and has not succeeded since. Above
 * zero, those tenants answer 503 while their backoff runs.
 */
export function migrationFailedTenantsGauge(registry: Registry): Gauge {
  return new Gauge({
    name: 'brain_migration_failed_tenants',
    help: 'Databases whose last schema apply on this replica failed (they answer 503 during backoff)',
    registers: [registry],
    collect() {
      this.set(migrationFailureSnapshot().failingDatabases);
    },
  });
}
