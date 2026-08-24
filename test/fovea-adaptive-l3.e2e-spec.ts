/**
 * Fovea optics (Optics-2, docs/roadmap/fovea-optics-2026-08.md §4.1) —
 * confidence-gated L3 escalation depth, e2e over a real SurrealDB
 * (testcontainer). The generator + verifier are scripted via
 * mockSynthesizeOpenAi (the L3 lane reuses the synthesize-owned OpenAI
 * client, so one queue drives all four calls: round-1 generate → verify →
 * L3 generate → L3 verify).
 *
 * Two scenarios, both with RETRIEVAL_L3_ESCALATION + FOVEA_ADAPTIVE_L3 on:
 *   - a seeded per-class calibration map that outputs LOW confidence → L3
 *     fires via the ADAPTIVE path (brain_l3_adaptive_trigger_total path
 *     ="adaptive"), the L3 answer is returned.
 *   - NO calibration map persisted → the load-bearing safety property: the
 *     lane behaves EXACTLY like the static L3 (fires on the same static
 *     condition, brain_l3_adaptive_trigger_total path="static").
 *
 * A fact's grounding session (source.episodeIds) is stamped directly onto
 * directly-created episode rows so the read path resolves an anchor without
 * a derive run (same idiom as l3-escalation.e2e-spec.ts).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { StringRecordId } from 'surrealdb';

describe('Fovea Optics-2 adaptive L3 escalation e2e', () => {
  // Anchored-fact tenant (adaptive path) and an isolated no-model tenant
  // (static fallback), so the two scenarios cannot see each other's rows.
  let fAdaptive: AppFixture;
  let fStatic: AppFixture;
  const authAdaptive = () => ({ Authorization: `Bearer ${fAdaptive.apiKey}` });
  const authStatic = () => ({ Authorization: `Bearer ${fStatic.apiKey}` });

  const ANCHOR_OBJECT = 'sapphire-crest-o2';
  const ANCHOR_QUERY = 'what is the tier sapphire-crest-o2';

  const R1_GEN = JSON.stringify({ answer: 'A thin, unsupported guess.', citedFactIds: [] });
  const R1_VERIFY = JSON.stringify({
    verdict: 'unsupported',
    unsupportedClaims: ['A thin, unsupported guess.'],
    questionAnswered: false,
  });
  const L3_ANSWER = 'The tier is sapphire-crest, per the full session.';
  const l3Ok = (factId: string) => [
    JSON.stringify({ answer: L3_ANSWER, citedFactIds: [factId] }),
    JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
  ];

  async function triggerPathCount(app: AppFixture, path: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`brain_l3_adaptive_trigger_total\\{path="${path}"\\} (\\d+)`));
    return m ? parseInt(m[1]!, 10) : 0;
  }

  // Ingest the anchored fact + its grounding episode session on a tenant.
  async function seedAnchor(app: AppFixture, auth: () => Record<string, string>): Promise<string> {
    const a = await app.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cust_o2_anchor' },
        predicate: 'tier',
        object: ANCHOR_OBJECT,
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_o2_a' },
        confidence: 0.9,
      });
    const factId = a.body.factId as string;
    expect(factId).toBeTruthy();
    const surreal = app.app.get(SurrealService);
    await surreal.withCompany(app.companyId, async (db) => {
      await db.query(
        `CREATE episode:o2ep1 CONTENT {
           kind: 'turn', messageId: 'm_o2_a', conversationId: 'conv_o2',
           speaker: 'user', text: $t1, occurredAt: $o1, source: {}
         };
         CREATE episode:o2ep2 CONTENT {
           kind: 'turn', messageId: 'm_o2_a2', conversationId: 'conv_o2',
           speaker: 'assistant', text: $t2, occurredAt: $o2, source: {}
         }`,
        {
          t1: `My tier is ${ANCHOR_OBJECT}, I confirmed it last week.`,
          t2: `Understood — you are on ${ANCHOR_OBJECT}.`,
          o1: new Date('2026-04-01T10:00:00Z'),
          o2: new Date('2026-04-01T10:01:00Z'),
        },
      );
      await db.query(`UPDATE $rid SET source.episodeIds = ['episode:o2ep1', 'episode:o2ep2']`, {
        rid: new StringRecordId(factId),
      });
    });
    return factId;
  }

  beforeAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    delete process.env.FOVEA_ADAPTIVE_L3;
    delete process.env.FOVEA_ADAPTIVE_L3_THRESHOLD;
    fAdaptive = await createApp();
    fStatic = await createApp();

    const adaptiveFactId = await seedAnchor(fAdaptive, authAdaptive);
    const staticFactId = await seedAnchor(fStatic, authStatic);
    (fStatic as unknown as { staticFactId: string }).staticFactId = staticFactId;

    // Seed a USABLE per-class calibration model on the adaptive tenant only:
    // a flat 'default' map that outputs 0.05 for any raw confidence, well
    // below the 0.5 escalate threshold → the adaptive gate always fires.
    const surreal = fAdaptive.app.get(SurrealService);
    await surreal.withCompany(fAdaptive.companyId, async (db) => {
      await db.query(
        `CREATE focus_calibration CONTENT {
           queryClass: 'default', thresholds: [1.0], values: [0.05],
           sampleCount: 100, version: 1
         }`,
      );
    });

    // Store the anchored factId for the adaptive test's L3 citation.
    (fAdaptive as unknown as { anchoredFactId: string }).anchoredFactId = adaptiveFactId;
  });

  afterAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    delete process.env.FOVEA_ADAPTIVE_L3;
    delete process.env.FOVEA_ADAPTIVE_L3_THRESHOLD;
    if (fAdaptive) await fAdaptive.close();
    if (fStatic) await fStatic.close();
  });

  it('flag on + seeded low-confidence model → L3 fires via the ADAPTIVE path', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_ADAPTIVE_L3 = '1';
    const factId = (fAdaptive as unknown as { anchoredFactId: string }).anchoredFactId;
    const adaptiveBefore = await triggerPathCount(fAdaptive, 'adaptive');
    const state = mockSynthesizeOpenAi(fAdaptive.app, [R1_GEN, R1_VERIFY, ...l3Ok(factId)]);
    const res = await fAdaptive.http
      .post('/v1/synthesize')
      .set(authAdaptive())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // The adaptive gate fired and the scripted L3 answer flipped the verdict.
    expect(res.body.answer).toBe(L3_ANSWER);
    // round-1 generate + verify, then L3 generate + verify.
    expect(state.calls.length).toBe(4);
    expect(state.calls[2]!.user).toContain('Full conversation transcripts');
    // The fired trigger was labeled 'adaptive', not 'static'.
    expect(await triggerPathCount(fAdaptive, 'adaptive')).toBe(adaptiveBefore + 1);
  });

  it('flag on + NO calibration model → byte-identical to the STATIC L3', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_ADAPTIVE_L3 = '1';
    const factId = (fStatic as unknown as { staticFactId: string }).staticFactId;
    // The static tenant has no focus_calibration rows, so the adaptive
    // resolver returns undefined → the lane runs its static coverage path.
    const staticBefore = await triggerPathCount(fStatic, 'static');
    const adaptiveBefore = await triggerPathCount(fStatic, 'adaptive');
    const state = mockSynthesizeOpenAi(fStatic.app, [R1_GEN, R1_VERIFY, ...l3Ok(factId)]);
    const res = await fStatic.http
      .post('/v1/synthesize')
      .set(authStatic())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // Same static condition fires the ladder (verifier-fail + below floor).
    expect(res.body.answer).toBe(L3_ANSWER);
    expect(state.calls.length).toBe(4);
    // Fired via the STATIC path — the no-model fallback.
    expect(await triggerPathCount(fStatic, 'static')).toBe(staticBefore + 1);
    expect(await triggerPathCount(fStatic, 'adaptive')).toBe(adaptiveBefore);
  });
});
