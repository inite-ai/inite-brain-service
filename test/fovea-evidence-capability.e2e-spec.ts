/**
 * Evidence-capability verdict gate e2e (FOVEA_EVIDENCE_CAPABILITY, 0113)
 * over a real SurrealDB (testcontainer). A tenant predicate declares
 * requiredEvidenceCapability='visual' on its knowledge_predicate row; a
 * supported answer citing a fact under that predicate must then ABSTAIN
 * with the NEW reason 'evidence_capability_unmet' — the honest v1 bound:
 * every citation today is text, so a non-text requirement can never be
 * met (fail-closed plumbing; media verifiers arrive with the M-track).
 * Flag off ⇒ the same scripted calls serve exactly as today.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { MetricsService } from '../src/metrics/metrics.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { SurrealService } from '../src/db/surreal.service';

describe('Fovea evidence-capability gate e2e', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  let visualFactId: string;

  const FACT_OBJECT = 'the evacuation plan is pinned on the ops-room whiteboard';
  const QUERY = 'where is the evacuation plan pinned';
  const ANSWER = 'On the ops-room whiteboard.';
  const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });

  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  async function capabilityCounter(outcome: 'checked' | 'downgraded'): Promise<number> {
    const { body } = await f.app.get(MetricsService).serialize();
    const m = body.match(
      new RegExp(`^brain_evidence_capability_total\\{outcome="${outcome}"\\} (\\d+)`, 'm'),
    );
    return m ? parseInt(m[1]!, 10) : 0;
  }

  beforeAll(async () => {
    // Pin abstention off so a thin-evidence query never pre-abstains before
    // generation — keeps the gen+verify call sequence deterministic.
    for (const [k, v] of Object.entries({ RETRIEVAL_ABSTENTION_CALIBRATION: 'off' })) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    delete process.env.FOVEA_EVIDENCE_CAPABILITY;
    f = await createApp({ companyId: 'co_evidence_capability_e2e' });

    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ops_room' },
        // 'status' is a CORE predicate (active in every tenant registry) —
        // the fact lands under it deterministically (no canonicalize roll).
        predicate: 'status',
        object: FACT_OBJECT,
        validFrom: new Date('2026-05-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        userId: 'u_cap',
      });
    expect([200, 201]).toContain(r.status);
    visualFactId = r.body.factId as string;
    expect(visualFactId).toBeTruthy();

    // Operator declares the requirement on the TENANT registry row (0113
    // column; no admin API in this PR — plumbing only), then invalidates
    // the snapshot cache so the gate sees it immediately.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE knowledge_predicate SET requiredEvidenceCapability = 'visual',
           updatedAt = time::now()
         WHERE predicateId = 'status'`,
      );
    });
    f.app.get(PredicateRegistryService).invalidate(f.companyId);
  });

  afterEach(() => {
    delete process.env.FOVEA_EVIDENCE_CAPABILITY;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it("flag ON: a supported answer citing a visual-required predicate abstains with 'evidence_capability_unmet'", async () => {
    process.env.FOVEA_EVIDENCE_CAPABILITY = '1';
    const beforeDown = await capabilityCounter('downgraded');
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: ANSWER, citedFactIds: [visualFactId] }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: 'u_cap' });
    expect(res.status).toBe(201);
    // Downgraded, fail-closed — text citations cannot satisfy 'visual'.
    expect(res.body.answer).not.toBe(ANSWER);
    expect(res.body.reason).toBe('evidence_capability_unmet');
    expect(res.body.citations ?? []).toEqual([]);
    // No extra LLM call — the gate is a registry lookup, not a judge:
    // exactly gen + verify.
    expect(state.calls.length).toBe(2);
    expect(await capabilityCounter('downgraded')).toBe(beforeDown + 1);
    expect(await capabilityCounter('checked')).toBeGreaterThanOrEqual(1);
  });

  it('flag OFF: the same scripted calls serve exactly as today (byte-identical)', async () => {
    // FOVEA_EVIDENCE_CAPABILITY unset (afterEach cleared it).
    const beforeDown = await capabilityCounter('downgraded');
    const beforeChecked = await capabilityCounter('checked');
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: ANSWER, citedFactIds: [visualFactId] }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: 'u_cap' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(ANSWER);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.citations?.map((c: { factId: string }) => c.factId)).toContain(visualFactId);
    expect(state.calls.length).toBe(2);
    // Neither series moved — the resolver never ran.
    expect(await capabilityCounter('downgraded')).toBe(beforeDown);
    expect(await capabilityCounter('checked')).toBe(beforeChecked);
  });
});
