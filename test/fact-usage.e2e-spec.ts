/**
 * Usage-based reinforcement e2e (migration 0053): with
 * SEARCH_USAGE_RECORDING_ENABLED the search pipeline stamps the facts it
 * surfaces into fact_usage (fire-and-forget — assertions poll), repeat
 * searches increment the same row via the UNIQUE factId index, the
 * decay-enrichment flag round-trips, and the GDPR forget cascade takes
 * the usage rows with the facts.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

interface UsageRow {
  readCount: number;
  lastReadAt: string;
}

describe('fact_usage — usage recording and cascade', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_usage_e2e' });
    process.env.SEARCH_USAGE_RECORDING_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.SEARCH_USAGE_RECORDING_ENABLED;
    delete process.env.SEARCH_USAGE_DECAY_ENABLED;
    if (f) await f.close();
  });

  const usageFor = async (factId: string): Promise<UsageRow | null> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[UsageRow[]]>(
        `SELECT readCount, lastReadAt FROM fact_usage
          WHERE factId = type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return (rows as UsageRow[])?.[0] ?? null;
    });
  };

  /** Recording is fire-and-forget — poll until the write lands. */
  const waitForCount = async (
    factId: string,
    atLeast: number,
  ): Promise<UsageRow | null> => {
    for (let i = 0; i < 40; i++) {
      const row = await usageFor(factId);
      if (row && row.readCount >= atLeast) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    return usageFor(factId);
  };

  it('stamps surfaced facts and increments on repeat searches', async () => {
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'usage_probe' },
      predicate: 'name',
      object: 'Usage Probe Tenant',
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(ingest.status);
    const factId = ingest.body.factId as string;

    const first = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Usage Probe Tenant', limit: 5 });
    expect(first.status).toBe(201);
    expect(first.body.results.length).toBeGreaterThan(0);

    const afterFirst = await waitForCount(factId, 1);
    expect(afterFirst).not.toBeNull();
    expect(afterFirst!.readCount).toBeGreaterThanOrEqual(1);

    const countAfterFirst = afterFirst!.readCount;
    const second = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Usage Probe Tenant', limit: 5 });
    expect(second.status).toBe(201);

    const afterSecond = await waitForCount(factId, countAfterFirst + 1);
    expect(afterSecond!.readCount).toBeGreaterThanOrEqual(countAfterFirst + 1);
    // ON DUPLICATE KEY UPDATE — one row per fact, not one per search.
    const surreal = f.app.get(SurrealService);
    const rowCount = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM fact_usage
          WHERE factId = type::record('knowledge_fact', $tail) GROUP ALL`,
        { tail: factId.split(':')[1] },
      );
      return (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
    });
    expect(rowCount).toBe(1);
  });

  it('search still answers with usage-aware decay enabled', async () => {
    process.env.SEARCH_USAGE_DECAY_ENABLED = '1';
    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Usage Probe Tenant', limit: 5 });
    delete process.env.SEARCH_USAGE_DECAY_ENABLED;
    expect(r.status).toBe(201);
    expect(r.body.results.length).toBeGreaterThan(0);
  });

  it('GDPR forget cascades over fact_usage', async () => {
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'usage_forget_subj' },
      predicate: 'name',
      object: 'Usage Forget Subject',
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    const factId = ingest.body.factId as string;

    const search = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Usage Forget Subject', limit: 5 });
    expect(search.status).toBe(201);
    const stamped = await waitForCount(factId, 1);
    expect(stamped).not.toBeNull();

    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return String((rows as Array<{ entityId: unknown }>)?.[0]?.entityId);
    });

    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-usage-1' });
    expect([200, 201]).toContain(forget.status);

    expect(await usageFor(factId)).toBeNull();
  });
});
