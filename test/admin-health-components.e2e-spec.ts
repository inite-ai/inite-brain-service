/**
 * The admin cockpit's health grid against a REAL SurrealDB, with the scoped
 * pool configured (migration 0005's `brain_caller`).
 *
 * What this pins: the grid has a row for the scoped read path, and the
 * grid, `/ready` and the capability probe say the same thing about the
 * same moment — the grid does not run its own probes, it reads the
 * readiness report and the probe's last outcome.
 */
import { AppFixture, createApp } from './app-fixture';
import { CapabilityProbeService } from '../src/metrics/capability-probe.service';
import { HealthComponentsResponseSchema } from '../src/contracts/admin/health-components.schema';

describe('GET /v1/admin/health/components (real SurrealDB, scoped pool on)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_health_grid_e2e', enableScopedPool: true });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('shows the scoped pool as its own row, agreeing with /ready', async () => {
    const ready = await f.http.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toMatchObject({ surrealdb: 'ok', scopedPool: 'ok' });

    const res = await f.http.get('/v1/admin/health/components').set(auth());
    expect(res.status).toBe(200);
    const parsed = HealthComponentsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);

    type Row = { name: string; status: string; message?: string; latencyMs?: number };
    const rows = res.body.components as Row[];
    const byName = new Map<string, Row>(rows.map((c) => [c.name, c]));
    expect(byName.get('surrealdb')).toMatchObject({ status: 'ok' });
    expect(typeof byName.get('surrealdb')?.latencyMs).toBe('number');
    // The row the cockpit never had: the caller-facing read path, authorized.
    expect(byName.get('scoped pool (brain_caller)')).toMatchObject({ status: 'ok' });
    expect(byName.get('scoped pool (brain_caller)')?.message).toContain('authorizes reads');
    // The embedder row is named by provider and reads /ready's definition.
    const embedder = [...byName.keys()].find((n) => n.startsWith('embedder ('));
    expect(embedder).toBeDefined();
    expect(byName.get(embedder!)).toMatchObject({ status: 'ok' });
  });

  it("annotates the rows with the probe's last outcome once the probe has run", async () => {
    const probe = f.app.get(CapabilityProbeService);
    const reports = await probe.runOnce();
    // The scoped read went through the real tenant database; the embed is
    // the fixture's stub, which answers in the configured space.
    expect(reports.find((r) => r.capability === 'scoped_read')?.outcome).toBe('serving');

    const res = await f.http.get('/v1/admin/health/components').set(auth());
    const scoped = res.body.components.find(
      (c: { name: string }) => c.name === 'scoped pool (brain_caller)',
    ) as { status: string; message: string };
    expect(scoped.status).toBe('ok');
    expect(scoped.message).toMatch(/probe serving \d+s ago/);
  });

  it('is admin-only', async () => {
    expect((await f.http.get('/v1/admin/health/components')).status).toBe(401);
  });
});
