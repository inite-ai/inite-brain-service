import { Gauge, type Registry } from 'prom-client';
import { migrationBlockedSnapshot } from '../db/migration-blocked';

/**
 * Tenant databases whose last schema apply failed, by the migration that
 * failed (src/db/migration-blocked.ts). Anything above zero is a tenant
 * Brain refuses entirely — reads, writes and jobs — until the file applies.
 */
export function migrationBlockedGauge(registry: Registry): Gauge<'migration'> {
  return new Gauge({
    name: 'brain_migration_blocked',
    help: 'Tenant databases whose pending migration fails to apply, by migration id',
    labelNames: ['migration'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [migration, tenants] of migrationBlockedSnapshot())
        this.set({ migration }, tenants);
    },
  });
}
