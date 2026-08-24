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
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
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
        { a: factIds[0]!.split(':')[1], b: factIds[1]!.split(':')[1] },
      );
    });

    const live = await liveCounts();
    const view = await viewCounts();
    expect(live.competing).toBeGreaterThanOrEqual(1);
    expect(live.retracted).toBeGreaterThanOrEqual(1);
    expect(view).toEqual(live);

    // Flip one back — the group counts must decrement/increment again.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE type::record('knowledge_fact', $a) SET status = 'active'`, {
        a: factIds[0]!.split(':')[1],
      });
    });
    expect(await viewCounts()).toEqual(await liveCounts());
  });

  it('deletes decrement the view counts', async () => {
    const before = await viewCounts();
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`DELETE type::record('knowledge_fact', $t)`, {
        t: factIds[3]!.split(':')[1],
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
      const res = (await db.query<unknown[]>(`SELECT n FROM stats_probe_initial`)) as Array<
        Array<{ n?: number }>
      >;
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
    const overview = await f.app.get(AdminService).buildOverview({
      brainAuth: { companyId: f.companyId, scopes: ['brain:admin'], keyHash: 'h' },
    } as never);
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

/**
 * Per-user scope on /v1/stats/overview (audit F3): a userId-pinned
 * end-user token must see only its OWN + tenant-global counts, never the
 * tenant aggregate spanning every user. Two user-bound tokens (user_a /
 * user_b) plus the M2M fixture key exercise the three cases in one boot.
 */
describe('stats overview per-user scope (audit F3, real SurrealDB)', () => {
  let f: AppFixture;
  const M2M = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const A = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
  const B = () => ({ Authorization: `Bearer ${f.extraApiKeys[1]}` });
  const savedFlag = process.env.STATS_VIEWS_ENABLED;

  // Fresh tenant DB → counts start at 0, so the expectations are exact.
  const GLOBAL_FACTS = 2;
  const A_FACTS = 3;
  const B_FACTS = 4;

  beforeAll(async () => {
    // Flag off: the M2M path uses the live tenant-wide counts. User
    // callers ignore the flag regardless (views are tenant-wide).
    delete process.env.STATS_VIEWS_ENABLED;
    f = await createApp({
      companyId: 'co_stats_userscope_e2e',
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], userId: 'user_a' },
        { scopes: ['brain:read', 'brain:write'], userId: 'user_b' },
      ],
    });

    // The M2M key mints tenant-global rows (userId IS NONE); each
    // user-bound key mints rows stamped with its own userId. Distinct
    // entity ids so every ingest INSERTs a fresh active fact + entity.
    for (let i = 0; i < GLOBAL_FACTS; i++) {
      await ingestAs(M2M(), `g_subject_${i}`, `g_claim_${i}`, `global claim ${i}`);
    }
    for (let i = 0; i < A_FACTS; i++) {
      await ingestAs(A(), `a_subject_${i}`, `a_claim_${i}`, `user a claim ${i}`);
    }
    for (let i = 0; i < B_FACTS; i++) {
      await ingestAs(B(), `b_subject_${i}`, `b_claim_${i}`, `user b claim ${i}`);
    }
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.STATS_VIEWS_ENABLED;
    else process.env.STATS_VIEWS_ENABLED = savedFlag;
    if (f) await f.close();
  });

  async function ingestAs(
    header: Record<string, string>,
    id: string,
    predicate: string,
    object: string,
  ) {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(header)
      .send({
        entityRef: { vertical: 'rent', id },
        predicate,
        object,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  }

  interface Overview {
    entities: number;
    factsActive: number;
    factsCompeting: number;
    factsRetracted: number;
    communities?: number;
    factsLast7d: number;
  }

  async function overview(header: Record<string, string>): Promise<Overview> {
    const res = await f.http.get('/v1/stats/overview').set(header);
    expect(res.status).toBe(200);
    return res.body as Overview;
  }

  it('user A sees only its own + tenant-global counts, never user B activity', async () => {
    const a = await overview(A());
    // A's own facts PLUS the tenant-global facts — and nothing of B's.
    expect(a.factsActive).toBe(A_FACTS + GLOBAL_FACTS); // 5, not 9
    expect(a.entities).toBe(A_FACTS + GLOBAL_FACTS);
    expect(a.factsLast7d).toBe(A_FACTS + GLOBAL_FACTS);
    // community_node has no userId → the tenant figure is omitted.
    expect(a.communities).toBeUndefined();
  });

  it('user B sees only its own + tenant-global counts, never user A activity', async () => {
    const b = await overview(B());
    expect(b.factsActive).toBe(B_FACTS + GLOBAL_FACTS); // 6, not 9
    expect(b.entities).toBe(B_FACTS + GLOBAL_FACTS);
    expect(b.communities).toBeUndefined();
  });

  it('the two users never see each other: A ≠ B, and neither equals the tenant aggregate', async () => {
    const a = await overview(A());
    const b = await overview(B());
    const tenant = await overview(M2M());
    // Each user is strictly below the tenant total by exactly the OTHER
    // user's contribution — proof that no cross-user rows bleed in.
    expect(tenant.factsActive).toBe(GLOBAL_FACTS + A_FACTS + B_FACTS); // 9
    expect(tenant.factsActive - a.factsActive).toBe(B_FACTS); // A excludes all of B
    expect(tenant.factsActive - b.factsActive).toBe(A_FACTS); // B excludes all of A
    expect(a.factsActive).not.toBe(b.factsActive);
  });

  it('M2M / admin caller (no pinned userId) still sees tenant-wide counts incl. communities', async () => {
    const tenant = await overview(M2M());
    expect(tenant.factsActive).toBe(GLOBAL_FACTS + A_FACTS + B_FACTS); // 9
    expect(tenant.entities).toBe(GLOBAL_FACTS + A_FACTS + B_FACTS); // 9
    // Tenant-global community count is present (a number) for M2M.
    expect(typeof tenant.communities).toBe('number');
  });

  it('the cache key does not cross users: back-to-back A/B calls stay scoped', async () => {
    // A is fetched first (populating the per-user cache entry), then B. A
    // shared tenant-only cache key would serve A's cached numbers to B.
    const a1 = await overview(A());
    const b = await overview(B());
    const a2 = await overview(A());
    expect(a1.factsActive).toBe(A_FACTS + GLOBAL_FACTS); // 5
    expect(b.factsActive).toBe(B_FACTS + GLOBAL_FACTS); // 6 — NOT A's 5
    expect(a2.factsActive).toBe(a1.factsActive); // A's own cached entry
  });
});
