/**
 * Migration 0088 stats views against a REAL SurrealDB (testcontainers,
 * 3.1.5): the first `AS SELECT` computed tables in the schema.
 *
 * Verifies the three properties the flag rollout rests on:
 *   1. the views track live GROUP counts INCREMENTALLY in both
 *      directions — creates increment, status flips move rows between
 *      groups, deletes decrement;
 *   2. a view defined AFTER data exists materializes the current counts
 *      at DEFINE time (what production tenants see when 0088 applies);
 *   3. STATS_VIEWS_ENABLED=on serves the same numbers through
 *      /v1/stats/overview and the admin fan-out as the flag-off live
 *      path, and off stays the legacy behavior.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { AdminService } from '../src/admin/admin.service';

interface LiveCounts {
  entities: number;
  active: number;
  competing: number;
  retracted: number;
}

describe('stats views (migration 0088, real SurrealDB)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedFlag = process.env.STATS_VIEWS_ENABLED;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_stats_views_e2e' });
    surreal = f.app.get(SurrealService);
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.STATS_VIEWS_ENABLED;
    else process.env.STATS_VIEWS_ENABLED = savedFlag;
    if (f) await f.close();
  });

  async function ingestFact(subjectId: string, predicate: string, object: string) {
    const res = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: subjectId },
      predicate,
      object,
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  }

  async function liveCounts(): Promise<LiveCounts> {
    return surreal.withCompany(f.companyId, async (db) => {
      const res = (await db.query<unknown[]>(`
        SELECT count() AS c FROM knowledge_entity GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'active' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'competing' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'retracted' GROUP ALL;
      `)) as Array<Array<{ c?: number }>>;
      return {
        entities: res[0]?.[0]?.c ?? 0,
        active: res[1]?.[0]?.c ?? 0,
        competing: res[2]?.[0]?.c ?? 0,
        retracted: res[3]?.[0]?.c ?? 0,
      };
    });
  }

  async function viewCounts(): Promise<LiveCounts> {
    return surreal.withCompany(f.companyId, async (db) => {
      const res = (await db.query<unknown[]>(`
        SELECT n FROM stats_entity_total;
        SELECT n, status FROM stats_fact_by_status;
      `)) as Array<Array<{ n?: number; status?: string }>>;
      const byStatus = new Map<string, number>();
      for (const row of res[1] ?? []) {
        if (typeof row.status === 'string' && typeof row.n === 'number') {
          byStatus.set(row.status, row.n);
        }
      }
      return {
        entities: res[0]?.[0]?.n ?? 0,
        active: byStatus.get('active') ?? 0,
        competing: byStatus.get('competing') ?? 0,
        retracted: byStatus.get('retracted') ?? 0,
      };
    });
  }

  const factIds: string[] = [];

  it('views exist after migration and track ingested rows incrementally', async () => {
    factIds.push(await ingestFact('stats_subject_a', 'claim_alpha', 'first claim'));
    factIds.push(await ingestFact('stats_subject_a', 'claim_beta', 'second claim'));
    factIds.push(await ingestFact('stats_subject_b', 'claim_gamma', 'third claim'));
    factIds.push(await ingestFact('stats_subject_b', 'claim_delta', 'fourth claim'));

    const live = await liveCounts();
    const view = await viewCounts();
    expect(live.active).toBeGreaterThanOrEqual(4);
    expect(view).toEqual(live);
  });

  it('status flips move rows between view groups (both directions)', async () => {
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE type::record('knowledge_fact', $a) SET status = 'competing';
         UPDATE type::record('knowledge_fact', $b) SET status = 'retracted';`,
        { a: factIds[0].split(':')[1], b: factIds[1].split(':')[1] },
      );
    });

    const live = await liveCounts();
    const view = await viewCounts();
    expect(live.competing).toBeGreaterThanOrEqual(1);
    expect(live.retracted).toBeGreaterThanOrEqual(1);
    expect(view).toEqual(live);

    // Flip one back — the group counts must decrement/increment again.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE type::record('knowledge_fact', $a) SET status = 'active'`,
        { a: factIds[0].split(':')[1] },
      );
    });
    expect(await viewCounts()).toEqual(await liveCounts());
  });

  it('deletes decrement the view counts', async () => {
    const before = await viewCounts();
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`DELETE type::record('knowledge_fact', $t)`, {
        t: factIds[3].split(':')[1],
      });
    });
    const live = await liveCounts();
    const view = await viewCounts();
    expect(view.active).toBe(before.active - 1);
    expect(view).toEqual(live);
  });

  it('a view defined AFTER data exists materializes current counts at DEFINE time', async () => {
    // This is the production-migration case: tenant tables already hold
    // rows when 0088 applies. 3.1.5 runs the full SELECT once at DEFINE.
    const live = await liveCounts();
    const probed = await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `DEFINE TABLE stats_probe_initial AS
           SELECT count() AS n FROM knowledge_entity GROUP ALL`,
      );
      const res = (await db.query<unknown[]>(
        `SELECT n FROM stats_probe_initial`,
      )) as Array<Array<{ n?: number }>>;
      await db.query(`REMOVE TABLE stats_probe_initial`);
      return res[0]?.[0]?.n ?? 0;
    });
    expect(probed).toBe(live.entities);
  });

  it('flag on serves view-backed numbers through /v1/stats/overview; flag off stays legacy', async () => {
    const live = await liveCounts();

    process.env.STATS_VIEWS_ENABLED = '1';
    const on = await f.http.get('/v1/stats/overview').set(auth());
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({
      entities: live.entities,
      factsActive: live.active,
      factsCompeting: live.competing,
      factsRetracted: live.retracted,
    });

    delete process.env.STATS_VIEWS_ENABLED;
    const off = await f.http.get('/v1/stats/overview').set(auth());
    expect(off.status).toBe(200);
    // Same data state → identical numbers on the legacy live path.
    const { asOf: _onAsOf, ...onRest } = on.body;
    const { asOf: _offAsOf, ...offRest } = off.body;
    expect(offRest).toEqual(onRest);
  });

  it('flag on: overview reflects a write immediately (no 30s LRU on the view path)', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const before = await f.http.get('/v1/stats/overview').set(auth());
    factIds.push(await ingestFact('stats_subject_c', 'claim_epsilon', 'fifth claim'));
    const after = await f.http.get('/v1/stats/overview').set(auth());
    expect(after.body.factsActive).toBe(before.body.factsActive + 1);
    delete process.env.STATS_VIEWS_ENABLED;
  });

  it('admin fan-out reads the same counters from the views', async () => {
    process.env.STATS_VIEWS_ENABLED = '1';
    const live = await liveCounts();
    const overview = await f.app.get(AdminService).buildOverview();
    const row = overview.tenants.find((t) => t.companyId === f.companyId);
    expect(row).toEqual({
      companyId: f.companyId,
      entities: live.entities,
      factsActive: live.active,
      factsRetracted: live.retracted,
    });
    delete process.env.STATS_VIEWS_ENABLED;
  });
});
