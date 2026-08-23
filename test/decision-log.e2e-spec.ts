/**
 * Phase 1 e2e — DecisionLog returned by /v1/synthesize { explain: true }.
 *
 * Closes the P0 gap from the test-coverage audit: the unit-spec
 * already exercises buildDecisionLog() pure, but the full HTTP path
 * (search → factIndex → generator → DecisionLog attach) was untested.
 *
 * Stub OpenAI emits a deterministic { answer, citedFactIds }
 * response so we can assert the picked / rejected ordering and
 * rejection-reason attribution end-to-end.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';

describe('Phase 1 e2e — DecisionLog via /v1/synthesize', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    // Seed two facts on the same entity so DecisionLog has both a
    // picked and a rejected row to attribute.
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'decision_log_tenant' },
        predicate: 'status',
        object: 'engineer',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'auth.profile_updated' },
        confidence: 0.9,
      });
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'decision_log_tenant' },
        predicate: 'tier',
        object: 'gold',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
        confidence: 0.9,
      });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('attaches a per-fact DecisionLog when explain=true', async () => {
    // Generator stub picks the first retrieved factId, then verifier
    // reports `supported` so we land in the ok branch.
    const factsRes = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'engineer', limit: 5 });
    const firstFactId = factsRes.body.results[0]?.facts[0]?.factId;
    expect(firstFactId).toBeTruthy();

    const generatorResp = JSON.stringify({
      answer: `Result [${firstFactId}].`,
      citedFactIds: [firstFactId],
    });
    const verifierResp = JSON.stringify({
      verdict: 'supported',
      unsupportedClaims: [],
    });
    mockSynthesizeOpenAi(f.app, [generatorResp, verifierResp]);

    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer', limit: 5, explain: true });
    expect(res.status).toBe(201);
    expect(res.body.decisionLog).toBeDefined();
    expect(Array.isArray(res.body.decisionLog)).toBe(true);
    const log = res.body.decisionLog as Array<any>;
    expect(log.length).toBeGreaterThan(0);

    const picked = log.filter((e: any) => e.picked === true);
    const rejected = log.filter((e: any) => e.picked === false);
    expect(picked.length).toBeGreaterThan(0);

    // Picked first, rejected after — invariant the unit-spec enforces.
    const firstPickedIdx = log.findIndex((e: any) => e.picked);
    const firstRejectedIdx = log.findIndex((e: any) => !e.picked);
    if (firstRejectedIdx >= 0) {
      expect(firstPickedIdx).toBeLessThan(firstRejectedIdx);
    }
    // Every rejected entry carries a deterministic reason.
    for (const r of rejected) {
      expect(typeof r.rejectReason).toBe('string');
      expect([
        'low_score',
        'not_relevant_to_query',
        'backfill_context_only',
        'duplicate_predicate',
      ]).toContain(r.rejectReason);
    }

    // scoreBreakdown components carry through end-to-end.
    expect(log[0].scoreBreakdown).toBeDefined();
    expect(typeof log[0].scoreBreakdown.finalScore).toBe('number');
    expect(Array.isArray(log[0].scoreBreakdown.stages)).toBe(true);
  });

  it('omits decisionLog when explain is falsy (back-compat)', async () => {
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok.', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer', limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.decisionLog).toBeUndefined();
  });
});
