/**
 * Phase 4.B e2e — lang-filtered first pass + cross-lingual backoff.
 *
 * Setup: ingest a Russian-tagged fact + an English-tagged fact on the
 * same entity, both about the same role.
 *
 * Verifies:
 *   1. Default behaviour: an English query surfaces both the English
 *      fact AND the Russian fact (cross-lingual backoff path kicks in
 *      because the filtered first pass under-fills the candidate set).
 *   2. `disableLangFilter: true` forces a single-pass search (used by
 *      multilingual debug paths).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('Phase 4.B — lang-filtered retrieve', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();

    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cross_lingual_tenant' },
        predicate: 'status',
        object: 'Технический директор',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
      });
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cross_lingual_tenant' },
        predicate: 'tier',
        object: 'gold member',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
      });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('cross-lingual backoff surfaces the Russian fact for an English query', async () => {
    const res = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Who is the CTO at this tenant', limit: 10 });
    expect(res.status).toBe(201);
    const facts = res.body.results.flatMap((r: any) => r.facts);
    const objects: string[] = facts.map((f: any) => f.object);
    // The Russian-tagged "Технический директор" must still surface
    // even though the query was detected as English. If the backoff
    // path didn't run, the lang filter would silently drop it.
    expect(objects.some((o: string) => o.includes('Технический'))).toBe(true);
  });

  it('disableLangFilter:true skips the filter entirely (single-pass)', async () => {
    const res = await f.http.post('/v1/search').set(auth()).send({
      query: 'Who is the CTO at this tenant',
      limit: 10,
      disableLangFilter: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it('honours explicit queryLang override', async () => {
    const res = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'status', limit: 10, queryLang: 'ru' });
    expect(res.status).toBe(201);
    expect(res.body.results.length).toBeGreaterThan(0);
  });
});
