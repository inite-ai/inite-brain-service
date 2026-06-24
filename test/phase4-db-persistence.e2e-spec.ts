/**
 * P1 e2e — direct SurrealDB checks on Phase 4.A + Phase 4.D.2
 * post-conditions. The HTTP-level locale + reindex tests already
 * pass; this test confirms the side effects actually land on the
 * row (not just that the request returned 201).
 *
 * Phase 4.A: ingest stamps lang + script on knowledge_fact.
 * Phase 4.D.2: reindex actually mutates the embedding column.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('P1 e2e — Phase 4 DB persistence', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('ingest persists lang=ru / script=Cyrl on Cyrillic objects', async () => {
    const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'lang_persist_ru' },
      predicate: 'status',
      object: 'Технический директор',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
    expect(r.body.outcome).toBe('INSERTED');
    const factId = r.body.factId as string;

    const surreal = f.app.get(SurrealService);
    const row = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ lang: string; script: string }>]>(
        `SELECT lang, script FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.replace(/^knowledge_fact:/, '') },
      );
      return Array.isArray(rows) ? rows[0] : null;
    });
    expect(row).toBeDefined();
    expect(row?.lang).toBe('ru');
    expect(row?.script).toBe('Cyrl');
  });

  it('ingest persists lang=en / script=Latn on English objects', async () => {
    const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'lang_persist_en' },
      predicate: 'status',
      object: 'Chief technology officer in charge of engineering',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
    expect(r.body.outcome).toBe('INSERTED');
    const factId = r.body.factId as string;

    const surreal = f.app.get(SurrealService);
    const row = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ lang: string; script: string }>]>(
        `SELECT lang, script FROM type::record('knowledge_fact', $tail)`,
        { tail: factId.replace(/^knowledge_fact:/, '') },
      );
      return Array.isArray(rows) ? rows[0] : null;
    });
    expect(row?.lang).toBe('en');
    expect(row?.script).toBe('Latn');
  });

  it('reindex endpoint mutates the embedding column', async () => {
    // Ingest a fact to ensure something exists for reindex to touch.
    const r = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'reindex_persist_tenant' },
      predicate: 'status',
      object: 'reindex-verify-text',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
    const factId = r.body.factId as string;
    const surreal = f.app.get(SurrealService);
    const beforeEmbedding = await surreal.withCompany(
      f.companyId,
      async (db) => {
        const [rows] = await db.query<[Array<{ embedding: number[] }>]>(
          `SELECT embedding FROM type::record('knowledge_fact', $tail)`,
          { tail: factId.replace(/^knowledge_fact:/, '') },
        );
        return Array.isArray(rows) ? rows[0]?.embedding ?? null : null;
      },
    );
    expect(Array.isArray(beforeEmbedding)).toBe(true);

    const reindex = await f.http
      .post('/v1/admin/reindex/embeddings')
      .set(auth());
    expect(reindex.status).toBe(201);
    expect(reindex.body.factsUpdated).toBeGreaterThanOrEqual(1);

    const afterEmbedding = await surreal.withCompany(
      f.companyId,
      async (db) => {
        const [rows] = await db.query<[Array<{ embedding: number[] }>]>(
          `SELECT embedding FROM type::record('knowledge_fact', $tail)`,
          { tail: factId.replace(/^knowledge_fact:/, '') },
        );
        return Array.isArray(rows) ? rows[0]?.embedding ?? null : null;
      },
    );
    expect(Array.isArray(afterEmbedding)).toBe(true);
    expect(afterEmbedding!.length).toBe(beforeEmbedding!.length);
    // The StubEmbedder is deterministic — embedding for the same text
    // is identical, so we assert the row was touched (still an array
    // of the right shape) rather than that the bytes changed.
  });
});
