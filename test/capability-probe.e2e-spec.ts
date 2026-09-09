/**
 * Capability probe against a REAL SurrealDB (testcontainers, v3.2.4,
 * started by test/global-setup.ts).
 *
 * WHAT THIS PINS. The probe must go RED exactly when the caller-facing read
 * path cannot authorize — the state incident #502 produced for ~59 minutes
 * of every process lifetime — and it must go green again by itself when the
 * path recovers, without a restart.
 *
 * HOW THE DEAD STATE IS PRODUCED HERE. Not by waiting an hour, and not by
 * mocking a clock (which poisons the SurrealDB session — learned in #481).
 * The scoped user is provisioned with a 5-second token, so every acquire
 * re-signs; rotating `brain_caller`'s password on the server then makes the
 * very next acquire fail closed. That is the same terminal state as the
 * original outage — the pool cannot authorize — reached in one statement.
 *
 * The control that matters is in the same test: while the probe is red,
 * `ping()` — the signal `/health` reports, and the one that stayed green
 * throughout the real outage — is still true.
 */
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { CapabilityProbeService } from '../src/metrics/capability-probe.service';
import type { ApiKeyService } from '../src/auth/api-key.service';

const SCOPED_USER = 'brain_caller';
const SCOPED_PASS = 'capability-probe-spec';
const ROTATED_PASS = 'capability-probe-spec-rotated';
/** Short enough that every acquire re-signs (the keeper's margin is 5 min). */
const TOKEN_DURATION = '5s';

async function seriesValue(
  metrics: MetricsService,
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) return undefined;
  const snapshot = (await metric.get()) as {
    values: Array<{ labels: Record<string, string | number>; value: number }>;
  };
  return snapshot.values.find((v) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  )?.value;
}

describe('Capability probe — scoped read path', () => {
  const tenant = `capprobe${Date.now().toString(36)}`;
  const saved: Record<string, string | undefined> = {};
  let namespace: string;
  let root: Surreal;
  let svc: SurrealService;
  let metrics: MetricsService;
  let probe: CapabilityProbeService;

  const setEnv = (key: string, value: string) => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };

  const defineScopedUser = (password: string) =>
    root.query(
      `DEFINE USER OVERWRITE ${SCOPED_USER} ON NAMESPACE PASSWORD '${password}' ` +
        `ROLES EDITOR DURATION FOR TOKEN ${TOKEN_DURATION}`,
    );

  const okGauge = () =>
    seriesValue(metrics, 'brain_capability_probe_ok', {
      capability: 'scoped_read',
    });
  const tickCount = (outcome: string) =>
    seriesValue(metrics, 'brain_capability_probe_total', { capability: 'scoped_read', outcome });

  beforeAll(async () => {
    const url = process.env.SURREALDB_URL!;
    namespace = process.env.SURREALDB_NAMESPACE ?? 'brain';

    root = new Surreal();
    await root.connect(url);
    await root.signin({
      username: process.env.SURREALDB_USERNAME!,
      password: process.env.SURREALDB_PASSWORD!,
    });
    await root.query(`DEFINE NAMESPACE IF NOT EXISTS \`${namespace}\``);
    await root.use({ namespace });

    setEnv('SURREALDB_SCOPED_USER', SCOPED_USER);
    setEnv('SURREALDB_SCOPED_PASS', SCOPED_PASS);
    setEnv('SURREALDB_SCOPED_TOKEN_DURATION', TOKEN_DURATION);
    setEnv('SURREALDB_POOL_SIZE', '2');
    setEnv('SURREALDB_SCOPED_POOL_SIZE', '2');

    svc = new SurrealService(new ConfigService());
    await svc.onModuleInit();
    // Root first: migration 0005 defines brain_caller, which brain then
    // (re)provisions with the declared token lifetime — same order as boot.
    await svc.withCompany(tenant, (db) => db.query('RETURN 1'));
    await svc.withScopedCompany(tenant, ['brain:read'], (db) => db.query('RETURN 1'));

    metrics = new MetricsService();
    probe = new CapabilityProbeService(
      svc,
      { fanOutRoster: () => [tenant] } as unknown as ApiKeyService,
      metrics,
      undefined,
    );
  }, 180_000);

  afterAll(async () => {
    await svc?.onApplicationShutdown();
    // Put the shared container's scoped user back on the server default so
    // later specs in this worker are not left signing in on every read.
    await root
      ?.query(
        `DEFINE USER OVERWRITE ${SCOPED_USER} ON NAMESPACE PASSWORD '${SCOPED_PASS}' ROLES EDITOR`,
      )
      .catch(() => undefined);
    await root?.close().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports SERVING against a healthy scoped pool', async () => {
    const [scoped] = await probe.runOnce();
    expect(scoped).toEqual({ capability: 'scoped_read', outcome: 'serving' });
    expect(await okGauge()).toBe(1);
    expect(
      await seriesValue(metrics, 'brain_capability_probe_last_success_timestamp_seconds', {
        capability: 'scoped_read',
      }),
    ).toBeGreaterThan(0);
  }, 60_000);

  it('goes RED when the read path can no longer authorize — while ping() stays green', async () => {
    await defineScopedUser(ROTATED_PASS);

    const [scoped] = await probe.runOnce();

    expect(scoped?.outcome).toBe('unauthorized');
    expect(scoped?.detail).toContain(`tenant=${tenant}`);
    expect(await okGauge()).toBe(0);
    expect(await tickCount('unauthorized')).toBe(1);

    // THE control. This is the signal that reported "ok" throughout the
    // original outage: the socket is fine, the server is fine, and every
    // caller-facing read is failing. A monitor that cannot separate these
    // two is the monitor we already had.
    await expect(svc.ping()).resolves.toBe(true);
    await expect(
      svc.withScopedCompany(tenant, ['brain:read'], (db) => db.query('RETURN 1')),
    ).rejects.toThrow();
  }, 60_000);

  it('recovers by itself once the path can authorize again', async () => {
    await defineScopedUser(SCOPED_PASS);

    const [scoped] = await probe.runOnce();

    expect(scoped?.outcome).toBe('serving');
    // The alert clears without an operator touching it — a probe that
    // latched would be indistinguishable from a stuck one.
    expect(await okGauge()).toBe(1);
    expect(await tickCount('serving')).toBe(2);
  }, 60_000);
});
