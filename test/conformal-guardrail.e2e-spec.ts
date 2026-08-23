/**
 * Phase 3.C e2e — SYNTHESIZE_MIN_CONFIDENCE drops low-confidence facts
 * before the generator sees them as citation targets.
 *
 * Closes the P0 gap from the test-coverage audit: the pure
 * applyConformalGuardrail unit-spec exists, but the env-knob → DI →
 * synthesize wiring was untested.
 *
 * Strategy: bump SYNTHESIZE_MIN_CONFIDENCE before createApp(), seed
 * facts whose calibrated confidence we can place on either side of
 * the threshold, then assert that the stub OpenAI generator's user
 * message lists only the high-confidence factIds.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';

describe('Phase 3.C e2e — conformal guardrail', () => {
  const PRIOR_FLOOR = process.env.SYNTHESIZE_MIN_CONFIDENCE;
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // Raise the floor before the SynthesizeService constructor runs.
    process.env.SYNTHESIZE_MIN_CONFIDENCE = '0.5';
    f = await createApp();

    // Two facts on the same entity. Calibration shrinks raw 0.95 to
    // roughly ~0.70 (above the 0.5 floor) and raw 0.05 stays low
    // (below the floor) per the bootstrap gold set.
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'conformal_tenant' },
      predicate: 'status',
      object: 'high confidence claim',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
      confidence: 0.95,
    });
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'conformal_tenant' },
      predicate: 'tier',
      object: 'low confidence claim',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'billing.tier_change' },
      confidence: 0.05,
    });
  });

  afterAll(async () => {
    if (PRIOR_FLOOR === undefined) delete process.env.SYNTHESIZE_MIN_CONFIDENCE;
    else process.env.SYNTHESIZE_MIN_CONFIDENCE = PRIOR_FLOOR;
    if (f) await f.close();
  });

  it('drops below-floor facts from the generator prompt', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'high confidence claim', limit: 5 });
    expect(res.status).toBe(201);
    // Generator was called — there's at least one above-floor fact.
    expect(state.calls.length).toBeGreaterThan(0);
    const generatorUser = state.calls[0]!.user;
    expect(generatorUser).toContain('high confidence claim');
    // And the low-confidence object never reaches the prompt.
    expect(generatorUser).not.toContain('low confidence claim');
  });
});
