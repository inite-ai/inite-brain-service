/**
 * G1 answer cache e2e — the wired path over a real SurrealDB
 * (testcontainer): flag off → no rows; flag on → write-through
 * admission, exact-match cached serving (no LLM calls), retraction of
 * a cited fact invalidates via check-on-read, and user scopes never
 * share entries. The generator/verifier are scripted via
 * mockSynthesizeOpenAi so every fresh synthesis is deterministic.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

interface CacheRow {
  hitCount: number;
  invalidationCause?: string | null;
  userId?: string | null;
  answer: string;
}

describe('G1 answer cache e2e', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const QUERY = 'tier: sapphire-crest';

  async function cacheRows(): Promise<CacheRow[]> {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[CacheRow[]]>('SELECT * FROM answer_cache');
      return rows ?? [];
    });
  }

  /** Script one fresh generate+verify round citing `factId`. */
  function mockRound(answer: string, factId: string) {
    return mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer, citedFactIds: [factId] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
  }

  let factId: string;

  beforeAll(async () => {
    process.env.SYNTHESIZE_ANSWER_CACHE = '0';
    f = await createApp();
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cust_answer_cache' },
        predicate: 'tier',
        object: 'sapphire-crest',
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_ac_1' },
        confidence: 0.9,
      });
    factId = ingest.body.factId;
    expect(factId).toBeTruthy();
  });

  afterAll(async () => {
    delete process.env.SYNTHESIZE_ANSWER_CACHE;
    if (f) await f.close();
  });

  it('flag off → synthesize succeeds and stores no cache rows', async () => {
    mockRound('Sapphire crest tier.', factId);
    const res = await f.http.post('/v1/synthesize').set(auth()).send({ query: QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe('Sapphire crest tier.');
    expect(res.body.cached).toBeUndefined();
    expect(await cacheRows()).toHaveLength(0);
  });

  it('flag on → first synthesize stores, second serves cached with no LLM call', async () => {
    process.env.SYNTHESIZE_ANSWER_CACHE = '1';

    const state1 = mockRound('The tier is sapphire-crest.', factId);
    const res1 = await f.http.post('/v1/synthesize').set(auth()).send({ query: QUERY, limit: 5 });
    expect(res1.status).toBe(201);
    expect(res1.body.answer).toBe('The tier is sapphire-crest.');
    expect(res1.body.cached).toBeUndefined();
    expect(state1.calls.length).toBe(2); // generator + verifier ran
    const afterStore = await cacheRows();
    expect(afterStore).toHaveLength(1);
    expect(afterStore[0]!.hitCount).toBe(0);

    // Second identical query (typographic variant): served from the
    // cache — the scripted DIFFERENT answer must never surface, and
    // the OpenAI stub must never be called.
    const state2 = mockRound('A DIFFERENT answer that must not surface.', factId);
    const res2 = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: `  ${QUERY.toUpperCase()}?`, limit: 5 });
    expect(res2.status).toBe(201);
    expect(res2.body.cached).toBe(true);
    expect(res2.body.answer).toBe('The tier is sapphire-crest.');
    expect(res2.body.citations?.[0]?.factId).toBe(factId);
    expect(res2.body.results).toEqual([]);
    expect(state2.calls.length).toBe(0);
    const afterServe = await cacheRows();
    expect(afterServe).toHaveLength(1);
    expect(afterServe[0]!.hitCount).toBe(1);
  });

  it('retracting a cited fact → check-on-read invalidates (cause=retracted) and re-synthesizes', async () => {
    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set(auth())
      .send({ reason: 'operator correction', retractedBy: { source: 'human' } });
    expect(retract.status).toBe(201);

    mockRound('Fresh post-retraction answer.', factId);
    const res3 = await f.http.post('/v1/synthesize').set(auth()).send({ query: QUERY, limit: 5 });
    expect(res3.status).toBe(201);
    expect(res3.body.cached).toBeUndefined();
    // The cached answer must not surface once its cited fact is dead.
    expect(res3.body.answer).not.toBe('The tier is sapphire-crest.');
    // The retracted fact left active retrieval, so the fresh round is
    // NOT admitted (either no_results before the LLM, or an uncited
    // path) — the invalidated row must survive with its cause.
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invalidationCause).toBe('retracted');
  });

  it('cross-user isolation: same query, different user scope → miss', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cust_answer_cache_iso' },
        predicate: 'status',
        object: 'meridian-blue',
        validFrom: new Date('2026-04-02').toISOString(),
        source: { vertical: 'rent', messageId: 'm_ac_2' },
        confidence: 0.9,
      });
    const isoFactId = ingest.body.factId as string;
    const isoQuery = 'status: meridian-blue';

    // User A stores an entry.
    mockRound('Meridian blue, for user A.', isoFactId);
    const resA = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: isoQuery, limit: 5, userId: 'user_a' });
    expect(resA.status).toBe(201);
    expect(resA.body.cached).toBeUndefined();

    // User B, same query: MUST NOT hit user A's entry — the fresh
    // round runs (stub called) and stores B's own row.
    const stateB = mockRound('Meridian blue, for user B.', isoFactId);
    const resB = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: isoQuery, limit: 5, userId: 'user_b' });
    expect(resB.status).toBe(201);
    expect(resB.body.cached).toBeUndefined();
    expect(resB.body.answer).toBe('Meridian blue, for user B.');
    expect(stateB.calls.length).toBe(2);

    // User A again: served A's own entry, not B's.
    const stateA2 = mockRound('Must not be generated.', isoFactId);
    const resA2 = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: isoQuery, limit: 5, userId: 'user_a' });
    expect(resA2.status).toBe(201);
    expect(resA2.body.cached).toBe(true);
    expect(resA2.body.answer).toBe('Meridian blue, for user A.');
    expect(stateA2.calls.length).toBe(0);

    const userRows = (await cacheRows()).filter((r) => r.userId);
    expect(userRows.map((r) => r.userId).sort()).toEqual(['user_a', 'user_b']);
  });
});
