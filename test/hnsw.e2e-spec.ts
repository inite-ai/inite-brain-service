/**
 * HNSW opt-in against a REAL SurrealDB 3.1.5: the admin endpoint builds
 * the per-tenant indexes with the live embedder's dimension, the KNN
 * vector leg answers with the same top hit as the exact full scan, and
 * a tenant WITHOUT indexes soft-falls back to the scan — the global
 * flag is safe mid-rollout.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('HNSW vector leg (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_hnsw_e2e' });
  });

  afterAll(async () => {
    delete process.env.SEARCH_HNSW_ENABLED;
    if (f) await f.close();
  });

  const search = async (query: string) => {
    const r = await f.http.post('/v1/search').set(auth()).send({ query, limit: 5 });
    expect(r.status).toBe(201);
    return r.body.results as Array<{ canonicalName: string }>;
  };

  it('answers via fallback when the flag is on but no index exists yet', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'hnsw_subject' },
        predicate: 'name',
        object: 'HNSW Probe Tenant',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(ingest.status);

    process.env.SEARCH_HNSW_ENABLED = '1';
    const results = await search('HNSW Probe Tenant');
    delete process.env.SEARCH_HNSW_ENABLED;
    expect(results.length).toBeGreaterThan(0);
    // canonicalName defaults to the entityRef id at upsert time.
    expect(results[0]!.canonicalName).toBe('hnsw_subject');
  });

  it('creates indexes with the live dimension and matches the exact scan', async () => {
    // A second entity so ranking has something to order.
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'hnsw_other' },
        predicate: 'name',
        object: 'Unrelated Neighbour',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });

    const create = await f.http.post('/v1/admin/maintenance/hnsw').set(auth()).send({});
    expect(create.status).toBe(201);
    expect(create.body.action).toBe('create');
    expect(create.body.dimension).toBe(1536); // StubEmbedder
    expect(create.body.indexes).toContain('fact_embedding_hnsw');
    expect(create.body.indexes).toContain('segment_embedding_hnsw');

    const baseline = await search('HNSW Probe Tenant');

    process.env.SEARCH_HNSW_ENABLED = '1';
    const viaKnn = await search('HNSW Probe Tenant');
    delete process.env.SEARCH_HNSW_ENABLED;

    expect(viaKnn.length).toBeGreaterThan(0);
    expect(viaKnn[0]!.canonicalName).toBe(baseline[0]!.canonicalName);
  });

  it('drop removes the indexes and search still answers', async () => {
    const drop = await f.http
      .post('/v1/admin/maintenance/hnsw')
      .set(auth())
      .send({ action: 'drop' });
    expect(drop.status).toBe(201);
    expect(drop.body.action).toBe('drop');

    process.env.SEARCH_HNSW_ENABLED = '1';
    const results = await search('HNSW Probe Tenant');
    delete process.env.SEARCH_HNSW_ENABLED;
    expect(results.length).toBeGreaterThan(0);
  });

  it('refuses create when an index exists at a stale dimension', async () => {
    // Fresh, empty tenant so a mismatched index can be planted directly
    // (DEFINE at a wrong dimension only fails once rows disagree).
    const g = await createApp({ companyId: 'co_hnsw_dim_e2e' });
    try {
      const surreal = g.app.get(SurrealService);
      await surreal.withCompany(g.companyId, async (db) => {
        await db.query(
          `DEFINE INDEX fact_embedding_hnsw ON knowledge_fact FIELDS embedding
             HNSW DIMENSION 8 DIST COSINE EFC 200 M 16;`,
        );
      });

      // The live StubEmbedder reports 1536 — a naive create would report
      // success (IF NOT EXISTS no-ops) yet leave the dim-8 index in place.
      const create = await g.http
        .post('/v1/admin/maintenance/hnsw')
        .set({ Authorization: `Bearer ${g.apiKey}` })
        .send({});
      expect(create.status).toBe(400);
      expect(String(create.body.message)).toMatch(/different dimension/i);

      // The documented recovery — drop first — then create succeeds.
      const drop = await g.http
        .post('/v1/admin/maintenance/hnsw')
        .set({ Authorization: `Bearer ${g.apiKey}` })
        .send({ action: 'drop' });
      expect(drop.status).toBe(201);

      const recreate = await g.http
        .post('/v1/admin/maintenance/hnsw')
        .set({ Authorization: `Bearer ${g.apiKey}` })
        .send({});
      expect(recreate.status).toBe(201);
      expect(recreate.body.dimension).toBe(1536);
    } finally {
      await g.close();
    }
  });
});
