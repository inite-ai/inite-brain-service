/**
 * A tenant whose next migration fails is refused by every request and every
 * job claim (SurrealService.ensureSchema runs first); on 2026-11-13 four
 * tenants sat behind 0184 for hours with the service healthy. The ledger
 * feeds `brain_migration_blocked`, which the MigrationBlocked alert reads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from 'prom-client';
import {
  clearMigrationBlocked,
  migrationBlockedSnapshot,
  recordMigrationBlocked,
} from '../src/db/migration-blocked';
import { processGauges } from '../src/metrics/process-gauges';

describe('blocked migrations', () => {
  afterEach(() => {
    for (const db of ['co_a', 'co_b', 'co_c']) clearMigrationBlocked(db);
  });

  it('counts blocked tenants per migration, once per tenant, and clears on success', () => {
    recordMigrationBlocked('co_a', '0184');
    recordMigrationBlocked('co_a', '0184');
    recordMigrationBlocked('co_b', '0184');
    recordMigrationBlocked('co_c', '0190');
    expect(Object.fromEntries(migrationBlockedSnapshot())).toEqual({ '0184': 2, '0190': 1 });
    clearMigrationBlocked('co_a');
    clearMigrationBlocked('co_c');
    expect(Object.fromEntries(migrationBlockedSnapshot())).toEqual({ '0184': 1 });
  });

  it('is exported as brain_migration_blocked{migration}', async () => {
    const registry = new Registry();
    processGauges(registry);
    recordMigrationBlocked('co_a', '0184');
    const text = await registry.metrics();
    expect(text).toContain('brain_migration_blocked{migration="0184"} 1');
    clearMigrationBlocked('co_a');
    expect(await registry.metrics()).not.toContain('brain_migration_blocked{');
  });

  it('has an alert that reads it', () => {
    const rules = readFileSync(
      join(__dirname, '..', 'monitoring', 'grafana', 'provisioning', 'alerting', 'rules.yaml'),
      'utf8',
    );
    expect(rules).toContain('title: MigrationBlocked');
    expect(rules).toContain('brain_migration_blocked');
  });
});
