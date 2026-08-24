/**
 * Phase 4.D.2 e2e — admin reindex endpoint.
 *
 * Verifies the operator-facing surface:
 *   - dryRun=true counts facts but never writes
 *   - dryRun=false (default) re-embeds and reports updated count
 *   - maxFacts caps the work even when more facts exist
 *   - response carries the active provider id
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('Phase 4.D.2 — POST /v1/admin/reindex/embeddings', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    for (let i = 0; i < 3; i++) {
      await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: `reindex_tenant_${i}` },
          predicate: 'status',
          object: `seed object ${i}`,
          validFrom: '2026-04-01',
          source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        });
    }
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('dryRun=true counts facts without updating', async () => {
    const res = await f.http.post('/v1/admin/reindex/embeddings?dryRun=true').set(auth());
    expect(res.status).toBe(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.factsScanned).toBeGreaterThanOrEqual(3);
    expect(res.body.factsUpdated).toBe(0);
    expect(typeof res.body.provider).toBe('string');
  });

  it('default run re-embeds facts', async () => {
    const res = await f.http.post('/v1/admin/reindex/embeddings').set(auth());
    expect(res.status).toBe(201);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.factsScanned).toBeGreaterThanOrEqual(3);
    expect(res.body.factsUpdated).toBeGreaterThanOrEqual(3);
  });

  it('maxFacts caps the work', async () => {
    const res = await f.http
      .post('/v1/admin/reindex/embeddings?maxFacts=1&dryRun=true')
      .set(auth());
    expect(res.status).toBe(201);
    expect(res.body.factsScanned).toBeLessThanOrEqual(1);
  });
});
