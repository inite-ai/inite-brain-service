/**
 * Read-side query expansion e2e — the degradation contract: with the
 * flag ON but the expansion LLM unreachable (stub OpenAI key), the
 * stage budget fails open and the original-query legs serve the search
 * exactly as before. Budget shrunk to keep the test fast.
 */
import { AppFixture, createApp } from './app-fixture';

describe('query expansion — soft-fail path', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // Read at service construction — must be set before createApp.
    process.env.SEARCH_QUERY_EXPANSION_ENABLED = '1';
    process.env.SEARCH_STAGE_BUDGET_QUERY_EXPANSION_MS = '300';
    f = await createApp({ companyId: 'co_qexp_e2e' });
  });

  afterAll(async () => {
    delete process.env.SEARCH_QUERY_EXPANSION_ENABLED;
    delete process.env.SEARCH_STAGE_BUDGET_QUERY_EXPANSION_MS;
    if (f) await f.close();
  });

  it('search answers normally when the expansion LLM is unreachable', async () => {
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'qexp_probe' },
      predicate: 'name',
      object: 'Expansion Probe Tenant',
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(ingest.status);

    const r = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Expansion Probe Tenant', limit: 5 });
    expect(r.status).toBe(201);
    expect(r.body.results.length).toBeGreaterThan(0);
  });
});
