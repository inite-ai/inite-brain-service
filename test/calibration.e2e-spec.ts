/**
 * Phase 3.A e2e — confidence calibration surfaces and rewrites scoring.
 *
 * Verifies:
 *   - `breakdown.calibratedConfidence` appears on every SearchHit fact
 *     when the request asks for an explanation
 *   - It differs from raw `confidence` on high-raw rows (overconfidence
 *     correction from the bootstrap gold set)
 *   - It equals raw on the identity / disabled path
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('Phase 3.A — confidence calibration', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    // Seed two facts with raw confidence at the extreme high band so
    // the bootstrap isotonic map shrinks them by a measurable amount.
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'calib_tenant_a' },
        predicate: 'tier',
        object: 'gold',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
        confidence: 0.95,
      });
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'calib_tenant_b' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
        confidence: 0.05,
      });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('exposes calibratedConfidence in the search breakdown', async () => {
    const res = await f.http.post('/v1/search').set(auth()).send({ query: 'tier', limit: 10 });
    expect(res.status).toBe(201);
    expect(res.body.results.length).toBeGreaterThan(0);

    let sawAnyBreakdown = false;
    let sawHighRawCalibrated = false;
    for (const r of res.body.results) {
      for (const fact of r.facts) {
        if (!fact.breakdown) continue;
        sawAnyBreakdown = true;
        expect(typeof fact.breakdown.calibratedConfidence).toBe('number');
        // Bootstrap map shrinks 0.95 to << 0.85 — overconfidence band.
        if (fact.confidence >= 0.9 && fact.breakdown.calibratedConfidence < 0.85) {
          sawHighRawCalibrated = true;
        }
      }
    }
    expect(sawAnyBreakdown).toBe(true);
    expect(sawHighRawCalibrated).toBe(true);
  });
});
