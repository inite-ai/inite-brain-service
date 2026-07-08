/**
 * e2e for the source-reputation track, Phase 3 (migration 0046):
 * declared source identity + the authority slot coming alive.
 *
 *   1. PUT /v1/admin/sources/:sourceKey declares type/authLevel; GET list/
 *      detail joins declared + learned reputation; malformed declares 400.
 *   2. THE FLIP: the resolver's authority weight (0.10, multiplied by a
 *      hardcoded 0.0 since migration 0006) now reads
 *      fn::source_authority_of. The same bitemporal conflict lands
 *      COMPETING for an unregistered challenger and SUPERSEDED once the
 *      challenger's source declares authLevel = 1.0 — per-source opt-in,
 *      byte-identical for everyone else.
 *
 * Default weights: margin = winner − loser must reach 0.15 to supersede.
 * Confidence 1.0-vs-0.8 gives 0.30·0.2 = 0.06 (< 0.15 → COMPETING);
 * +0.10·1.0 declared authority = 0.16 (≥ 0.15 → SUPERSEDED).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('source registry + authority activation (Phase 3)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const JUNIOR = { vertical: 'ops', recorder: 'junior_bot' };
  const SENIOR = { vertical: 'ops', recorder: 'senior_auditor' };
  const SENIOR_KEY = 'ops:senior_auditor';

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_source_registry_e2e' });
    // A bitemporal predicate — the COMPETING/SUPERSEDED margin math only
    // applies to bitemporal semantics (core seed has none).
    await f.http.post('/v1/admin/predicates').set(auth()).send({
      predicateId: 'field_report',
      semantics: 'bitemporal',
      piiClass: 'none',
      description: 'e2e: bitemporal conflict playground',
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingestReport = (entityId: string, source: object, confidence: number) =>
    f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'ops', id: entityId },
      predicate: 'field_report',
      // Identical object text → identical embeddings → cosine 1.0, so the
      // pair always enters the competing set; only the scores differ.
      object: 'amsterdam office is over capacity',
      validFrom: '2026-06-01T00:00:00Z',
      source,
      confidence,
    });

  it('declares a source and reads it back joined with reputation', async () => {
    const put = await f.http
      .put(`/v1/admin/sources/${encodeURIComponent(SENIOR_KEY)}`)
      .set(auth())
      .send({ type: 'human', authLevel: 1.0, owner: 'ops-team' });
    expect(put.status).toBe(200);
    expect(put.body.declared).toMatchObject({
      sourceKey: SENIOR_KEY,
      type: 'human',
      authLevel: 1.0,
      owner: 'ops-team',
    });

    const detail = await f.http
      .get(`/v1/admin/sources/${encodeURIComponent(SENIOR_KEY)}`)
      .set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.declared.type).toBe('human');

    const list = await f.http.get('/v1/admin/sources').set(auth());
    expect(list.status).toBe(200);
    const line = list.body.sources.find(
      (s: any) => s.sourceKey === SENIOR_KEY,
    );
    expect(line.declared.authLevel).toBe(1.0);

    // Malformed declares are 400s, not silent policy downgrades.
    const badType = await f.http
      .put(`/v1/admin/sources/x:y`)
      .set(auth())
      .send({ type: 'rumor_mill', authLevel: 0.5 });
    expect(badType.status).toBe(400);
    const badLevel = await f.http
      .put(`/v1/admin/sources/x:y`)
      .set(auth())
      .send({ type: 'api', authLevel: 1.5 });
    expect(badLevel.status).toBe(400);
  });

  it('declared authority flips a COMPETING conflict to SUPERSEDED', async () => {
    // Control: challenger from an UNREGISTERED source. Margin 0.06 < 0.15
    // → the resolver refuses to auto-pick.
    const controlIncumbent = await ingestReport('hq_control', JUNIOR, 0.8);
    expect(controlIncumbent.body.outcome).toBe('INSERTED');
    const controlChallenge = await ingestReport(
      'hq_control',
      { vertical: 'ops', recorder: 'unregistered_auditor' },
      1.0,
    );
    expect(controlChallenge.body.outcome).toBe('COMPETING');

    // Same conflict, but the challenger's source carries a declared
    // authLevel of 1.0 (registered in the previous test): margin 0.16.
    const incumbent = await ingestReport('hq_live', JUNIOR, 0.8);
    expect(incumbent.body.outcome).toBe('INSERTED');
    const challenge = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'ops', id: 'hq_live' },
      predicate: 'field_report',
      object: 'amsterdam office is over capacity',
      validFrom: '2026-06-01T00:00:00Z',
      source: SENIOR,
      confidence: 1.0,
      explain: true,
    });
    expect(challenge.body.outcome).toBe('SUPERSEDED');
    expect(challenge.body.supersededFactIds).toContain(
      incumbent.body.factId,
    );
    // The decomposition names authority as a live component now.
    expect(
      challenge.body.conflictExplanation.scoreBreakdown.winner.authority,
    ).toBeCloseTo(0.1);
  });

  it('get_source_reputation is served through the sources service', async () => {
    // The MCP tool wraps SourcesService.detail — covered at the HTTP layer
    // above; here we pin the declared authority surfaced to agents.
    const detail = await f.http
      .get(`/v1/admin/sources/${encodeURIComponent(SENIOR_KEY)}`)
      .set(auth());
    expect(detail.body.declared.authLevel).toBe(1.0);
    expect(Array.isArray(detail.body.trust)).toBe(true);
    expect(Array.isArray(detail.body.history)).toBe(true);
  });
});
