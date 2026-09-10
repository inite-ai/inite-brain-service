/**
 * Two things migration 0139 and the segment-leg rewiring promise, checked on
 * a real SurrealDB:
 *
 *  1. The retired column and indexes are gone from a migrated tenant and the
 *     maintenance route builds exactly the two indexes a query consumes.
 *  2. The segment leg rides segment_embedding_hnsw when the tenant has it
 *     (the statement carries the KNN operator) and returns the same rows,
 *     in the same order, from the exact scan when it does not — the index
 *     is an accelerator, never a different answer.
 */
import type { Surreal } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EmbedderService } from '../src/ai/embedder.service';
import { runSegmentLegs } from '../src/search/internals/segment-leg';

describe('segment HNSW index: retired indexes gone, segment leg rides the one that stays', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const TEXTS = [
    'the boiler in flat 4 was replaced on tuesday',
    'parking permits renew in march',
    'the lift inspection certificate expired',
  ];

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_segment_hnsw_e2e' });
    const embedder = f.app.get(EmbedderService);
    const surreal = f.app.get(SurrealService);
    const rows: Array<{
      conversationId: string;
      seq: number;
      episodeIds: string[];
      text: string;
      occurredAt: Date;
      recorder: string;
      embedding: number[];
    }> = [];
    for (let i = 0; i < TEXTS.length; i += 1) {
      const text = TEXTS[i]!;
      rows.push({
        conversationId: `conv_seg_${i}`,
        seq: 0,
        episodeIds: [],
        text,
        occurredAt: new Date(`2026-02-0${i + 1}T10:00:00Z`),
        recorder: 'test-seeder',
        embedding: await embedder.embed(text),
      });
    }
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`INSERT INTO episode_segment $rows`, { rows });
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('0139: altEmbedding is not a field any more, and create builds only the two consumed indexes', async () => {
    const surreal = f.app.get(SurrealService);
    const fields = await surreal.withCompany(f.companyId, async (db) => {
      const [info] = await db.query<[{ fields?: Record<string, string> }]>(
        `INFO FOR TABLE knowledge_fact;`,
      );
      return (info as { fields?: Record<string, string> })?.fields ?? {};
    });
    expect(fields.embedding).toBeDefined();
    expect(fields.altEmbedding).toBeUndefined();
    // 0140: `REMOVE FIELD altEmbedding` leaves the server-generated
    // `altEmbedding.*` element definition behind, and while it stands a
    // SCHEMAFULL write of the retired column is still accepted AND STORED
    // (measured on 3.2.4). A retired column has to reject writes.
    expect(fields['altEmbedding.*']).toBeUndefined();
    const write = await surreal.withCompany(f.companyId, async (db) => {
      const [ents] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE knowledge_entity SET type = 'other', canonicalName = 'alt probe'`,
      );
      const e = (ents as Array<{ id: unknown }>)[0]!.id;
      const row = `entityId = $e, predicate = 'alt_probe', object = 'o', confidence = 0.9,
         validFrom = time::now(), source = { vertical: 'rent', eventId: 'alt.probe' }`;
      // Baseline: the identical row WITHOUT the retired column is accepted,
      // so the rejection below is about altEmbedding and nothing else.
      await db.query(`CREATE knowledge_fact SET ${row}`, { e });
      try {
        await db.query(`CREATE knowledge_fact SET ${row}, altEmbedding = [1.0]`, { e });
        const [stored] = await db.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM knowledge_fact WHERE altEmbedding != NONE`,
        );
        return { rejected: false, stored: ((stored as unknown[]) ?? []).length };
      } catch (err) {
        return { rejected: true, message: (err as Error).message };
      }
    });
    expect(write).toMatchObject({ rejected: true, message: expect.stringMatching(/altEmbedding/) });

    const create = await f.http.post('/v1/admin/maintenance/hnsw').set(auth()).send({});
    expect(create.status).toBe(201);
    expect([...create.body.indexes].sort()).toEqual([
      'fact_embedding_hnsw',
      'segment_embedding_hnsw',
    ]);
    expect(create.body.ready).toBe(true);

    const leftovers = await surreal.withCompany(f.companyId, async (db) => {
      const [fact] = await db.query<[{ indexes?: Record<string, string> }]>(
        `INFO FOR TABLE knowledge_fact;`,
      );
      const [entity] = await db.query<[{ indexes?: Record<string, string> }]>(
        `INFO FOR TABLE knowledge_entity;`,
      );
      return [
        ...Object.keys((fact as { indexes?: Record<string, string> })?.indexes ?? {}),
        ...Object.keys((entity as { indexes?: Record<string, string> })?.indexes ?? {}),
      ].filter((n) => n.endsWith('_hnsw'));
    });
    expect(leftovers).toEqual(['fact_embedding_hnsw']);
  });

  it('the segment leg takes KNN with the index and the exact scan without it — same rows either way', async () => {
    const surreal = f.app.get(SurrealService);
    const embedder = f.app.get(EmbedderService);
    const queryVector = await embedder.embed(TEXTS[2]!);
    const tuning = { hnswEnabled: true, hnswEf: 100, hnswOverfetch: 4 };

    const run = (db: Surreal, hnswEnabled: boolean) => {
      const sqls: string[] = [];
      const spy: Pick<Surreal, 'query'> = {
        query: ((sql: string, params?: Record<string, unknown>) => {
          sqls.push(sql);
          return db.query(sql, params);
        }) as Surreal['query'],
      };
      return runSegmentLegs({
        db: spy,
        queryText: TEXTS[2]!,
        queryVector,
        fetchK: 3,
        callerScopes: ['brain:read', 'brain:read_pii'],
        mode: 'vector',
        tuning: { ...tuning, hnswEnabled },
      }).then((r) => ({ sqls, ids: r.vectorRows.map((row) => String(row.id)) }));
    };

    // With the index (built by the previous test): the dense statement is
    // the KNN operator, and the exact text is the top hit.
    const knn = await surreal.withCompany(f.companyId, (db) => run(db, true));
    expect(knn.sqls.some((s) => s.includes('<|'))).toBe(true);
    expect(knn.ids).toHaveLength(3);

    // Flag off: the exact scan, same rows in the same order.
    const brute = await surreal.withCompany(f.companyId, (db) => run(db, false));
    expect(brute.sqls.some((s) => s.includes('vector::similarity::cosine'))).toBe(true);
    expect(brute.sqls.some((s) => s.includes('<|'))).toBe(false);
    expect(brute.ids).toEqual(knn.ids);

    // Index gone, flag still on: the dropped operator is detected and the
    // exact scan answers — still the same rows.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`REMOVE INDEX IF EXISTS segment_embedding_hnsw ON episode_segment;`);
    });
    const fallback = await surreal.withCompany(f.companyId, (db) => run(db, true));
    expect(fallback.sqls.some((s) => s.includes('vector::similarity::cosine'))).toBe(true);
    expect(fallback.ids).toEqual(knn.ids);
  });
});
