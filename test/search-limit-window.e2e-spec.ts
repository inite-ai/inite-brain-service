/**
 * The rerank stage only ranks a bounded window (≤20 buckets). Before the
 * fix, `runRerankStage` returned at most that window and the tail was
 * silently dropped, so a search with limit > 20 could never return more
 * than 20 hits even though the DTO advertises @Max(100). This pins that a
 * limit above the rerank window is honored (tail refilled by rankScore).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('search honors limit beyond the rerank window', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_limit_window_e2e' });
    // 25 distinct entities, each with a name fact sharing a common token so
    // one query retrieves them all into separate buckets.
    for (let i = 0; i < 25; i++) {
      await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: `limitwin_${i}` },
          predicate: 'name',
          object: `Limit Window Probe ${i}`,
          validFrom: '2026-01-01',
          confidence: 0.9,
          source: { vertical: 'rent', recorder: 'bot' },
        });
    }
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('returns more than the 20-wide rerank window when limit=25', async () => {
    const res = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Limit Window Probe', limit: 25 });
    expect(res.status).toBe(201);
    // Before the fix this capped at 20 regardless of limit.
    expect(res.body.results.length).toBeGreaterThan(20);
  });
});
