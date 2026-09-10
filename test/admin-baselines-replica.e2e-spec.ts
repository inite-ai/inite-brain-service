/**
 * Eval baselines are shared across replicas (admin_baseline, 0140):
 * a baseline saved through replica A is listed, loaded and diffed
 * through replica B, because the row lives in the system database
 * rather than under one process's cwd-relative var/ directory.
 *
 * Two full app boots against the same SurrealDB stand in for two
 * replicas.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService, queryRows } from '../src/db/surreal.service';
import type { ScenarioRunOutcome } from '../src/admin/scenario-runner.service';

jest.setTimeout(180_000);

function outcome(scenarioId: string, recallAt1: number, recallAt5: number): ScenarioRunOutcome {
  return { scenarioId, metrics: { recallAt1, recallAt5 } } as unknown as ScenarioRunOutcome;
}

describe('eval baselines across replicas', () => {
  let a: AppFixture;
  let b: AppFixture;
  const name = `replica-${Date.now()}`;

  beforeAll(async () => {
    a = await createApp();
    b = await createApp();
  });

  afterAll(async () => {
    await b.close();
    await a.close();
  });

  it('a baseline saved on replica A is listed and diffed on replica B', async () => {
    const saved = await a.http
      .post(`/v1/admin/baselines/${name}`)
      .set({ Authorization: `Bearer ${a.apiKey}` })
      .send({ outcomes: [outcome('s1', 0.9, 1), outcome('s2', 0.5, 0.8)] });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ name, scenarios: 2, meanRecallAt1: 0.7 });

    const listed = await b.http
      .get('/v1/admin/baselines')
      .set({ Authorization: `Bearer ${b.apiKey}` });
    expect(listed.status).toBe(200);
    const entry = (listed.body as Array<{ name: string; savedAt: string }>).find(
      (x) => x.name === name,
    );
    expect(entry).toMatchObject({ name, savedAt: saved.body.savedAt });

    const diff = await b.http
      .post(`/v1/admin/baselines/${name}/diff`)
      .set({ Authorization: `Bearer ${b.apiKey}` })
      .send({ outcomes: [outcome('s1', 0.8, 1), outcome('s2', 0.6, 0.8)] });
    expect(diff.status).toBe(201);
    expect(diff.body.baseline).toBe(name);
    expect(diff.body.entries).toEqual([
      expect.objectContaining({ scenarioId: 's1', metric: 'recallAt1', verdict: 'regression' }),
      expect.objectContaining({ scenarioId: 's1', metric: 'recallAt5', verdict: 'stable' }),
      expect.objectContaining({ scenarioId: 's2', metric: 'recallAt1', verdict: 'improved' }),
      expect.objectContaining({ scenarioId: 's2', metric: 'recallAt5', verdict: 'stable' }),
    ]);
  });

  it('the row lives in the system database', async () => {
    const rows = await a.app
      .get(SurrealService)
      .withAdminDb((db) =>
        queryRows<{ name: string; scenarios: number }>(
          db,
          `SELECT name, scenarios FROM admin_baseline WHERE name = $name`,
          { name },
        ),
      );
    expect(rows).toEqual([{ name, scenarios: 2 }]);
  });

  it('an unknown baseline is a 404 on every replica', async () => {
    const res = await b.http
      .post(`/v1/admin/baselines/never-saved-${Date.now()}/diff`)
      .set({ Authorization: `Bearer ${b.apiKey}` })
      .send({ outcomes: [] });
    expect(res.status).toBe(404);
  });
});
