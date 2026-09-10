/**
 * A vector of the wrong width in a tenant's corpus — the preprod state on
 * 2026-09-09: 39 OpenAI 1536-wide fact vectors under a bge-m3 (1024) embedder.
 * Before the width gate, one such row made every cosine scan of the table an
 * error (dense retrieval down for every row) and every write of the entity's
 * aspect fail inside fn::resolve_fact. Now such a row is invisible to dense
 * retrieval, the census reports it, and the repair re-embeds it.
 *
 * The fixture's stub embedder is 1536-wide, so here the FOREIGN width is
 * 1024 — same class, mirrored.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EmbedderService } from '../src/ai/embedder.service';

describe('vector corpus width: gate, census, repair (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const FOREIGN = 1024;
  const vec = (w: number) => Array.from({ length: w }, (_, i) => (i % 7) / 7);

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_vector_width_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (object: string, entity = 'width_subject') => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: entity },
        predicate: 'complained_about',
        object,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    return res;
  };

  const inventory = async () => {
    const r = await f.http.get('/v1/admin/embedding-space/inventory').set(auth());
    expect(r.status).toBe(200);
    return r.body as {
      dimension: number;
      nonConforming: number;
      repairable: number;
      columns: Array<{ table: string; field: string; rows: number; nonConforming: number }>;
    };
  };

  it('a foreign-width row neither breaks dense search nor the write path, is counted, and is repaired', async () => {
    const first = await ingest('the elevator is broken again');
    expect([200, 201]).toContain(first.status);

    // Poison: a vector of another model's width on the same table.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE knowledge_fact SET embedding = $v, embeddingSpaceId = 'other:model:1024'
          WHERE predicate = 'complained_about' AND object = 'the elevator is broken again'`,
        { v: vec(FOREIGN) },
      );
    });

    // Read side: dense search over a table holding a foreign-width row.
    const search = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'elevator broken', limit: 5 });
    expect(search.status).toBe(201);

    // Write side: fn::resolve_fact's dedup gate compares the new vector with
    // every candidate of the aspect — the poisoned row is among them.
    const second = await ingest('the elevator is broken, third week');
    expect([200, 201]).toContain(second.status);

    // Census sees exactly the poisoned row, as repairable.
    const before = await inventory();
    const facts = before.columns.find(
      (c) => c.table === 'knowledge_fact' && c.field === 'embedding',
    )!;
    expect(before.dimension).toBe(1536);
    expect(facts.nonConforming).toBe(1);
    expect(before.repairable).toBeGreaterThanOrEqual(1);

    // Repair: the sweep re-embeds with the primary (stub, 1536).
    const repair = await f.http.post('/v1/admin/embedding-space/repair').set(auth()).send({});
    expect(repair.status).toBe(201);
    expect(repair.body.outcome).toBe('repaired');
    expect(repair.body.after.nonConforming).toBe(0);

    const after = await inventory();
    expect(after.nonConforming).toBe(0);
    const widths = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ w: number }>]>(
        `SELECT array::len(embedding) AS w FROM knowledge_fact WHERE embedding != NONE`,
      );
      return new Set((rows as Array<{ w: number }>).map((r) => Number(r.w)));
    });
    expect([...widths]).toEqual([1536]);
  });

  /**
   * The repair pays for the rows the census counted, not for the tenant. The
   * sweep it drives used to `SELECT id, predicate, object FROM knowledge_fact`
   * with no width filter, so ONE stray vector re-embedded (and rewrote) every
   * row of every swept table — the cost of a full migration for a one-row
   * defect, plus a write storm on rows that were already correct.
   */
  it('re-embeds only the non-conforming rows, not the whole tenant', async () => {
    for (const object of ['the intercom buzzes at night', 'bins collected on friday']) {
      expect([200, 201]).toContain((await ingest(object, 'width_narrow_subject')).status);
    }
    const poisoned = 'the stairwell light flickers';
    expect([200, 201]).toContain((await ingest(poisoned, 'width_narrow_subject')).status);

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE knowledge_fact SET embedding = $v
          WHERE predicate = 'complained_about' AND object = $object`,
        { v: vec(FOREIGN), object: poisoned },
      );
    });

    const conforming = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ c: number }>]>(
        `SELECT count() AS c FROM knowledge_fact
          WHERE embedding != NONE AND array::len(embedding) = 1536 GROUP ALL`,
      );
      return Number((rows as Array<{ c: number }>)[0]?.c ?? 0);
    });
    expect(conforming).toBeGreaterThan(1);

    // Count what the repair actually asks the embedder for.
    const embedder = f.app.get(EmbedderService);
    const embedded: string[] = [];
    const many = jest
      .spyOn(embedder, 'embedManyForWrite')
      .mockImplementation(async (texts: string[]) => {
        embedded.push(...texts);
        return Promise.all(texts.map((t) => embedder.embed(t)));
      });
    const one = jest.spyOn(embedder, 'embedForWrite');
    try {
      const repair = await f.http.post('/v1/admin/embedding-space/repair').set(auth()).send({});
      expect(repair.status).toBe(201);
      expect(repair.body.outcome).toBe('repaired');
      expect(repair.body.after.nonConforming).toBe(0);
    } finally {
      many.mockRestore();
      one.mockRestore();
    }
    // Exactly the poisoned row: `<predicate>: <object>` is the sweep's
    // projection for knowledge_fact.
    expect(embedded).toEqual([`complained_about: ${poisoned}`]);
    expect(one).not.toHaveBeenCalled();
  });
});
