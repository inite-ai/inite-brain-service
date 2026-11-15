/**
 * Caller meta on a mention (the family client's inbox context:
 * conversation_id, channel, direction, author).
 *
 * Under the production flag set (INGEST_MENTION_VIA_DOCUMENT,
 * SOURCE_META_STRICT on) a mention's `meta`:
 *   - passes the same gate as document `meta` / fact `metadata` — a
 *     camelCase key is a 400 `invalid_meta` and nothing is written;
 *   - is kept on the stored document and projected as each derived
 *     fact's `source.meta`, so it can be read back and matched by ABAC;
 *   - goes with the user's forget.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import type { ExtractionResult } from '../src/ai/extractor.service';

jest.setTimeout(180_000);

const MOVED: ExtractionResult = {
  entities: [{ name: 'Maria Lopez', type: 'person' }],
  facts: [{ entityIndex: 0, predicate: 'city', object: 'Lisbon', confidence: 0.9 }],
  edges: [],
};

const META = {
  conversation_id: 'conv-77',
  channel: 'telegram',
  direction: 'inbound',
  author: 'customer',
};

describe('mention meta', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const flags = ['DOCUMENT_INGEST_ENABLED', 'INGEST_MENTION_VIA_DOCUMENT', 'SOURCE_META_STRICT'];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_mention_meta_e2e' });
    for (const k of flags) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
  });

  afterAll(async () => {
    for (const k of flags) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (f) await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const query = <T>(sql: string, vars: Record<string, unknown>) =>
    f.app
      .get(SurrealService)
      .withCompany(f.companyId, async (db) => (await db.query<[T[]]>(sql, vars))[0] ?? []);

  it('refuses a meta bag that is not operator vocabulary, writing nothing', async () => {
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({ text: 'Maria said hi.', userId: 'u_bad', meta: { conversationId: 'c1' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_meta');
    const docs = await query<{ id: unknown }>('SELECT id FROM source_document WHERE userId = $u', {
      u: 'u_bad',
    });
    expect(docs).toHaveLength(0);
  });

  it('keeps the meta with the turn, projects it onto the facts, and forget erases it', async () => {
    f.extractor.setScript(MOVED);
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'Maria Lopez moved to Lisbon last month.',
        userId: 'u_meta',
        contextRef: { vertical: 'chat', conversationId: 'conv-77', messageId: 'msg-1' },
        meta: META,
      });
    expect(res.status).toBe(201);

    const docs = await query<{ meta?: Record<string, unknown> }>(
      'SELECT meta FROM source_document WHERE userId = $u',
      { u: 'u_meta' },
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]!.meta).toMatchObject(META);

    if (res.body.extractedFactIds?.length) {
      const facts = await query<{ meta?: Record<string, unknown> }>(
        'SELECT source.meta AS meta FROM knowledge_fact WHERE userId = $u',
        { u: 'u_meta' },
      );
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) expect(fact.meta).toMatchObject(META);
    }

    const forget = await f.http.post('/v1/users/u_meta/forget').set(auth()).send({});
    expect(forget.status).toBeLessThan(300);
    const after = await query<{ id: unknown }>('SELECT id FROM source_document WHERE userId = $u', {
      u: 'u_meta',
    });
    expect(after).toHaveLength(0);
  });
});
