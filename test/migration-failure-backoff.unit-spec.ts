/**
 * A migration that fails on one tenant must not brick it into a storm.
 *
 * Before: the failing database was never marked known, so EVERY request for
 * the tenant re-entered the global schema queue, re-ran the failing file and
 * answered 500. Now a failure opens a per-database cooldown (30 s doubling,
 * capped at 15 min): requests inside it fail fast with a 503 that carries no
 * tenant data, the first request after it retries once, a success clears it,
 * and the failure is counted for /metrics by migration id only.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Registry } from 'prom-client';
import { SurrealService } from '../src/db/surreal.service';
import { MigrationApplyError } from '../src/db/migrator.service';
import {
  MigrationBackoff,
  migrationBackoffMs,
  migrationFailureSnapshot,
  UNATTRIBUTED_MIGRATION,
} from '../src/db/migration-failures';
import { migrationFailuresCounter } from '../src/metrics/migration-failure-metrics';

describe('migrationBackoffMs', () => {
  it('starts at 30 s, doubles, and caps at 15 min', () => {
    expect(migrationBackoffMs(1)).toBe(30_000);
    expect(migrationBackoffMs(2)).toBe(60_000);
    expect(migrationBackoffMs(3)).toBe(120_000);
    expect(migrationBackoffMs(5)).toBe(480_000);
    expect(migrationBackoffMs(6)).toBe(900_000);
    expect(migrationBackoffMs(60)).toBe(900_000);
  });
});

describe('MigrationBackoff', () => {
  it('fails fast inside the window, lets one retry through after it, clears on success', () => {
    let clock = 1_000_000;
    const b = new MigrationBackoff(() => clock);
    expect(() => b.assertNotCoolingDown('co_x')).not.toThrow();
    expect(
      b.recordFailure('co_x', new MigrationApplyError('0042', '0042_x.surql', new Error('boom'))),
    ).toBe(30_000);
    expect(() => b.assertNotCoolingDown('co_x')).toThrow(ServiceUnavailableException);
    clock += 30_000;
    expect(() => b.assertNotCoolingDown('co_x')).not.toThrow();
    // The retry fails again: the window doubles.
    expect(b.recordFailure('co_x', new Error('again'))).toBe(60_000);
    clock += 59_999;
    expect(() => b.assertNotCoolingDown('co_x')).toThrow(ServiceUnavailableException);
    b.recordSuccess('co_x');
    expect(() => b.assertNotCoolingDown('co_x')).not.toThrow();
    // Another database was never affected.
    expect(() => b.assertNotCoolingDown('co_y')).not.toThrow();
  });

  it('answers a 503 whose message names no tenant', () => {
    const b = new MigrationBackoff(() => 0);
    b.recordFailure('co_secret-tenant', new Error('x'));
    try {
      b.assertNotCoolingDown('co_secret-tenant');
      throw new Error('expected a 503');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as Error).message).not.toMatch(/secret-tenant/);
    } finally {
      b.recordSuccess('co_secret-tenant');
    }
  });

  it('counts failures by migration id and tracks failing databases', () => {
    const b = new MigrationBackoff(() => 0);
    const before = migrationFailureSnapshot();
    const f77 = before.failures.get('0077') ?? 0;
    const fNone = before.failures.get(UNATTRIBUTED_MIGRATION) ?? 0;
    const failing = before.failingDatabases;
    b.recordFailure('co_m1', new MigrationApplyError('0077', '0077_x.surql', new Error('x')));
    b.recordFailure('co_m2', new Error('lease wait timed out'));
    const after = migrationFailureSnapshot();
    expect(after.failures.get('0077')).toBe(f77 + 1);
    expect(after.failures.get(UNATTRIBUTED_MIGRATION)).toBe(fNone + 1);
    expect(after.failingDatabases).toBe(failing + 2);
    b.recordSuccess('co_m1');
    b.forget('co_m2');
    expect(migrationFailureSnapshot().failingDatabases).toBe(failing);
  });
});

describe('migration failure metrics', () => {
  it('exports the counter by migration id, never a tenant', async () => {
    const registry = new Registry();
    migrationFailuresCounter(registry);
    const b = new MigrationBackoff(() => 0);
    b.recordFailure(
      'co_metric-tenant',
      new MigrationApplyError('0099', '0099_x.surql', new Error('x')),
    );
    try {
      const body = await registry.metrics();
      expect(body).toMatch(/brain_migration_failures_total\{migration="0099"\} \d+/);
      expect(body).not.toMatch(/metric-tenant/);
    } finally {
      b.recordSuccess('co_metric-tenant');
    }
  });
});

describe('SurrealService.ensureSchema after a failed migration', () => {
  function setup() {
    const svc = new SurrealService(new ConfigService());
    const state = svc as any;
    state.namespace = 'brain';
    const conn = {
      query: jest.fn(async () => [undefined]),
      use: jest.fn(async () => undefined),
    };
    state.migratorConn = conn;
    jest.spyOn(state, 'ensureSession').mockImplementation(async () => conn);
    let clock = 5_000_000;
    state.migrationBackoff = new MigrationBackoff(() => clock);
    let fail = true;
    const migrate = jest.fn(async () => {
      if (fail) throw new MigrationApplyError('0123', '0123_x.surql', new Error('boom'));
      return { applied: ['0123'], alreadyApplied: [] };
    });
    state.migrator = { migrate };
    return {
      ensureSchema: (database: string): Promise<void> => state.ensureSchema(database),
      migrate,
      advance: (ms: number) => (clock += ms),
      heal: () => (fail = false),
    };
  }

  it('does not re-run the failing file on every request while cooling down', async () => {
    const t = setup();
    await expect(t.ensureSchema('co_broken')).rejects.toBeInstanceOf(ServiceUnavailableException);
    for (let i = 0; i < 5; i++) {
      await expect(t.ensureSchema('co_broken')).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(t.migrate).toHaveBeenCalledTimes(1);
  });

  it('requests queued behind the failing apply fail fast too', async () => {
    const t = setup();
    const all = await Promise.allSettled([
      t.ensureSchema('co_broken'),
      t.ensureSchema('co_broken'),
      t.ensureSchema('co_broken'),
    ]);
    expect(all.every((r) => r.status === 'rejected')).toBe(true);
    expect(t.migrate).toHaveBeenCalledTimes(1);
  });

  it('retries once the window passes and recovers on success', async () => {
    const t = setup();
    await expect(t.ensureSchema('co_broken')).rejects.toBeInstanceOf(ServiceUnavailableException);
    t.advance(30_000);
    t.heal();
    await expect(t.ensureSchema('co_broken')).resolves.toBeUndefined();
    expect(t.migrate).toHaveBeenCalledTimes(2);
    await t.ensureSchema('co_broken'); // known now: no third apply
    expect(t.migrate).toHaveBeenCalledTimes(2);
  });

  it('one failing tenant does not hold up another', async () => {
    const t = setup();
    await expect(t.ensureSchema('co_broken')).rejects.toBeInstanceOf(ServiceUnavailableException);
    t.heal();
    await expect(t.ensureSchema('co_fine')).resolves.toBeUndefined();
  });
});
