/**
 * e2e for the source-reputation track, Phase 5: fact_trust at read time.
 *
 * Boots the app with SEARCH_TRUST_BETA=1 (env read at service
 * construction) and proves:
 *   1. response facts carry breakdown.factTrust (the "because"
 *      decomposition) and the fact-level sourceKey;
 *   2. with β on, an identical claim from a higher-trust source
 *      (declared tier: billing.* → 0.95) outranks the same claim from a
 *      neutral source (0.5) — trust actually moves rankings.
 *
 * The flags-off no-op contract is pinned by fact-trust-scoring.unit-spec
 * (identical scores with β=γ=0) and by the whole rest of the e2e suite
 * running with the flags unset.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('fact_trust in ranking (Phase 5, SEARCH_TRUST_BETA=1)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    process.env.SEARCH_TRUST_BETA = '1';
    // The band is part of the trust-ranking contract: without it a
    // reranker permutation can erase the trust-adjusted order (audit
    // 2026-08-21 P1). Default is 0 (off) — a trust experiment enables
    // both knobs together, exactly as this suite does.
    process.env.SEARCH_RERANK_TRUST_BAND = '0.1';
    f = await createApp({ companyId: 'co_fact_trust_e2e' });
  });

  afterAll(async () => {
    delete process.env.SEARCH_TRUST_BETA;
    delete process.env.SEARCH_RERANK_TRUST_BAND;
    if (f) await f.close();
  });

  it('trusted-source claim outranks the identical neutral-source claim; explain carries factTrust', async () => {
    // Two entities, same claim text — identical embeddings/decay/
    // confidence; the ONLY differentiator is the declared source tier
    // frozen into each fact's trustSnapshot (billing.* → 0.95 vs 0.5).
    const trusted = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'trusted_claim_entity' },
      predicate: 'status',
      object: 'contract renewal confirmed',
      validFrom: '2026-06-01T00:00:00Z',
      source: { vertical: 'rent', eventId: 'billing.renewal' },
      confidence: 0.9,
    });
    expect(trusted.body.outcome).toBe('INSERTED');
    const neutral = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'neutral_claim_entity' },
      predicate: 'status',
      object: 'contract renewal confirmed',
      validFrom: '2026-06-01T00:00:00Z',
      source: { vertical: 'rent', recorder: 'anon_scraper' },
      confidence: 0.9,
    });
    expect(neutral.body.outcome).toBe('INSERTED');
    // A distractor gives the fusion stage's min-max normalisation a
    // spread — with ONLY the two identical claims, max == min collapses
    // every fusedScore to 0 and the trust factor multiplies nothing.
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'distractor_entity' },
      predicate: 'status',
      object: 'janitorial schedule updated for west wing',
      validFrom: '2026-06-01T00:00:00Z',
      source: { vertical: 'rent', recorder: 'anon_scraper' },
      confidence: 0.9,
    });

    // NB: search has no `explain` flag — breakdown is always attached to
    // response facts (response-builder.ts); the types.ts "explain=true"
    // comment predates that.
    const search = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'status: contract renewal confirmed', limit: 5 });
    expect(search.status).toBe(201);

    const hits = search.body.results.filter((r: any) =>
      r.facts.some((x: any) => x.object === 'contract renewal confirmed'),
    );
    expect(hits.length).toBe(2);

    // β=1: trustFactor 1.45 (0.95 declared) vs 1.0 (neutral) — the
    // trusted source's entity must rank first.
    expect(hits[0].entityId).toContain('knowledge_entity:');
    const first = hits[0].facts.find(
      (x: any) => x.object === 'contract renewal confirmed',
    );
    const second = hits[1].facts.find(
      (x: any) => x.object === 'contract renewal confirmed',
    );
    expect(first.sourceKey).toBe('rent:_');
    expect(second.sourceKey).toBe('rent:anon_scraper');

    // The "because" decomposition rides the explain breakdown.
    expect(first.breakdown.factTrust).toMatchObject({
      sourceReputation: 0.95,
      trustFactor: 1.45,
      corroborationFactor: 1,
    });
    expect(second.breakdown.factTrust).toMatchObject({
      sourceReputation: 0.5,
      trustFactor: 1,
    });
    expect(first.score).toBeGreaterThan(second.score);
  });
});
