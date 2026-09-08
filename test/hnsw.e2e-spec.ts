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

  /**
   * The behaviour the whole fallback rests on, asserted against the real
   * engine rather than assumed. Before this was pinned, the leg's catch
   * clause waited for an exception that never arrives and the search was
   * answered from unranked table-order rows.
   */
  it('a missing index does not error — the KNN operator is dropped and every distance is null', async () => {
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
        `INFO FOR TABLE knowledge_fact;`,
      );
      // Precondition: this tenant genuinely has no HNSW index.
      expect((info as { indexes?: Record<string, string> })?.indexes?.fact_embedding_hnsw).toBe(
        undefined,
      );

      const [rows] = await db.query<[Array<{ id: unknown; knnDist: number | null }>]>(
        `SELECT id, vector::distance::knn() AS knnDist
           FROM knowledge_fact
          WHERE embedding <|8,100|> $q
          LIMIT 8`,
        { q: new Array(1536).fill(0.01) },
      );
      // Not an error, not empty — rows with NO similarity information.
      expect(Array.isArray(rows)).toBe(true);
      expect((rows ?? []).length).toBeGreaterThan(0);
      for (const r of rows ?? []) expect(typeof r.knnDist).not.toBe('number');

      // EXPLAIN confirms the operator left the plan entirely.
      const [plan] = await db.query<[unknown]>(
        `SELECT id FROM knowledge_fact WHERE embedding <|8,100|> $q EXPLAIN`,
        { q: new Array(1536).fill(0.01) },
      );
      expect(JSON.stringify(plan)).toContain('TableScan');
      expect(JSON.stringify(plan)).not.toContain('KnnScan');
    });
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
