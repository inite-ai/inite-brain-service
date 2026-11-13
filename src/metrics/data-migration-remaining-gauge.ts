import { Gauge, type Registry } from 'prom-client';
import { dataMigrationRemainingSnapshot } from '../db/data-migrations/data-migration-remaining';

/**
 * Rows a data migration still has to fix, summed over the tenants this
 * process has run it for (src/db/data-migrations/). Zero once every tenant
 * verified it done; a value that stops falling is a migration whose step
 * no longer fixes what its count finds.
 */
export function dataMigrationRemainingGauge(registry: Registry): Gauge<'migration'> {
  return new Gauge({
    name: 'brain_data_migration_remaining',
    help: 'Rows a data migration still has to fix, summed over tenants, by data migration id',
    labelNames: ['migration'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [migration, rows] of dataMigrationRemainingSnapshot())
        this.set({ migration }, rows);
    },
  });
}
