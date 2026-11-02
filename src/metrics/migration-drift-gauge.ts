import { Gauge, type Registry } from 'prom-client';
import { migrationDriftSnapshot } from '../db/migration-checksum';

/**
 * Tenants found, since boot, whose applied migration differs from the file
 * this build ships (src/db/migration-checksum.ts). Anything above zero is an
 * edited shipped migration: the change never ran there.
 */
export function migrationDriftGauge(registry: Registry): Gauge<'migration'> {
  return new Gauge({
    name: 'brain_migration_drift',
    help: 'Tenants whose applied migration differs from the shipped file, by migration id, since boot',
    labelNames: ['migration'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [migration, tenants] of migrationDriftSnapshot()) this.set({ migration }, tenants);
    },
  });
}
