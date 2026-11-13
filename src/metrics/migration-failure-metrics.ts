import { Counter, type Registry } from 'prom-client';
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
