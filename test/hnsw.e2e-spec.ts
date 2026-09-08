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
    delete process.env.SEARCH_HNSW_CONCURRENT;
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
    // Readiness is reported, not assumed — on the synchronous path too.
    expect(create.body.concurrent).toBe(false);
    expect(create.body.ready).toBe(true);
    expect(create.body.builds.map((b: { state: string }) => b.state)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
    ]);

    const baseline = await search('HNSW Probe Tenant');

    process.env.SEARCH_HNSW_ENABLED = '1';
    const viaKnn = await search('HNSW Probe Tenant');
    delete process.env.SEARCH_HNSW_ENABLED;

    expect(viaKnn.length).toBeGreaterThan(0);
    expect(viaKnn[0]!.canonicalName).toBe(baseline[0]!.canonicalName);
  });

  /**
   * SEARCH_HNSW_CONCURRENT against the real engine. The failure this
   * replaces is a scale failure (a synchronous build over 20 000 × 1024-d
   * aborts after ~133 s with a RocksDB transaction conflict) that a
   * fixture-sized tenant cannot reproduce; what IS assertable here is that
   * the CONCURRENTLY keyword parses on 3.2.4, that the four indexes really
   * land, that `INFO FOR INDEX` yields a build state the route reports, and
   * that a KNN search over the finished index still answers.
   */
  it('builds CONCURRENTLY, reports per-index readiness, and serves', async () => {
    process.env.SEARCH_HNSW_CONCURRENT = '1';
    try {
      const create = await f.http.post('/v1/admin/maintenance/hnsw').set(auth()).send({});
      expect(create.status).toBe(201);
      expect(create.body.concurrent).toBe(true);
      expect(create.body.ready).toBe(true);
      expect(create.body.builds).toHaveLength(4);
      for (const b of create.body.builds as Array<{ index: string; state: string }>) {
        expect(b.state).toBe('ready');
      }

      // The indexes are genuinely defined, not merely reported over.
      const surreal = f.app.get(SurrealService);
      await surreal.withCompany(f.companyId, async (db) => {
        const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
          `INFO FOR TABLE knowledge_fact;`,
        );
        expect(
          (info as { indexes?: Record<string, string> })?.indexes?.fact_embedding_hnsw,
        ).toContain('HNSW');
      });

      // status re-reads the same state without emitting DDL.
      const status = await f.http
        .post('/v1/admin/maintenance/hnsw')
        .set(auth())
        .send({ action: 'status' });
      expect(status.status).toBe(201);
      expect(status.body.action).toBe('status');
      expect(status.body.ready).toBe(true);

      process.env.SEARCH_HNSW_ENABLED = '1';
      const results = await search('HNSW Probe Tenant');
      delete process.env.SEARCH_HNSW_ENABLED;
      expect(results.length).toBeGreaterThan(0);
    } finally {
      delete process.env.SEARCH_HNSW_CONCURRENT;
    }
  });

  it('drop removes the indexes and search still answers', async () => {
    const drop = await f.http
      .post('/v1/admin/maintenance/hnsw')
      .set(auth())
      .send({ action: 'drop' });
    expect(drop.status).toBe(201);
    expect(drop.body.action).toBe('drop');
    // A dropped tenant is absent, never "ready".
    expect(drop.body.ready).toBe(false);
    for (const b of drop.body.builds as Array<{ state: string }>) expect(b.state).toBe('absent');

    process.env.SEARCH_HNSW_ENABLED = '1';
    const results = await search('HNSW Probe Tenant');
    delete process.env.SEARCH_HNSW_ENABLED;
    expect(results.length).toBeGreaterThan(0);
  });

  it('create RECREATES a stale-width index instead of refusing', async () => {
    // Fresh, empty tenant so a mismatched index can be planted directly
    // (DEFINE at a wrong dimension only fails once rows disagree).
    const g = await createApp({ companyId: 'co_hnsw_dim_e2e' });
    try {
      const surreal = g.app.get(SurrealService);
      const dimensionOf = async (): Promise<number | null> =>
        surreal.withCompany(g.companyId, async (db) => {
          const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
            `INFO FOR TABLE knowledge_fact;`,
          );
          const ddl = (info as { indexes?: Record<string, string> })?.indexes?.[
            'fact_embedding_hnsw'
          ];
          const m = ddl ? /DIMENSION\s+(\d+)/i.exec(String(ddl)) : null;
          return m ? parseInt(m[1]!, 10) : null;
        });

      await surreal.withCompany(g.companyId, async (db) => {
        await db.query(
          `DEFINE INDEX fact_embedding_hnsw ON knowledge_fact FIELDS embedding
             HNSW DIMENSION 8 DIST COSINE EFC 200 M 16;`,
        );
      });
      expect(await dimensionOf()).toBe(8);

      // One call, no drop step. `DEFINE INDEX IF NOT EXISTS` would have
      // silently no-opped here and left the dim-8 index in place while
      // reporting success — which is why create now REMOVEs first.
      const create = await g.http
        .post('/v1/admin/maintenance/hnsw')
        .set({ Authorization: `Bearer ${g.apiKey}` })
        .send({});
      expect(create.status).toBe(201);
      expect(create.body.dimension).toBe(1536); // StubEmbedder's declared space

      // The stale index is genuinely gone, not merely reported over.
      expect(await dimensionOf()).toBe(1536);
    } finally {
      await g.close();
    }
  });
});
