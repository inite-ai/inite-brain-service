/**
 * G2 L3 escalation e2e — the wired path over a real SurrealDB
 * (testcontainer). The generator + verifier are scripted via
 * mockSynthesizeOpenAi (the L3 lane reuses the same synthesize-owned
 * OpenAI client, so one scripted queue drives all four calls:
 * round-1 generate → round-1 verify → L3 generate → L3 verify).
 *
 *  - flag OFF → no L3 call, the normal (verifier-failed) abstention.
 *  - flag ON + verifier-fail + anchoring session + scripted L3 answer
 *    the verifier passes → the L3 answer is returned, metric 'flipped'.
 *  - flag ON + no anchor → abstain, no L3 call, metric
 *    'skipped_no_anchor'.
 *
 * A fact's grounding session (source.episodeIds) is normally stamped by
 * the deriver; here we ingest a searchable fact and link it to
 * directly-created episode rows so the read path resolves an anchor
 * deterministically without a derive run.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { StringRecordId } from 'surrealdb';

describe('G2 L3 escalation e2e', () => {
  let f: AppFixture;
  // Second tenant, isolated so the no-anchor case cannot retrieve the
  // anchored fact (any retrieved fact naming a session would satisfy the
  // anchor requirement — the fence is "≥1 anchor fact", tenant-wide).
  let f2: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const auth2 = () => ({ Authorization: `Bearer ${f2.apiKey}` });

  // Anchored fact — links to an episode session.
  const ANCHOR_OBJECT = 'sapphire-crest-l3';
  const ANCHOR_QUERY = 'what is the tier sapphire-crest-l3';
  let anchoredFactId: string;

  // Non-anchored fact (isolated tenant) — no source.episodeIds anywhere,
  // so no session to escalate to.
  const LONELY_OBJECT = 'meridian-blue-l3';
  const LONELY_QUERY = 'what is the status meridian-blue-l3';

  const R1_GEN = JSON.stringify({
    answer: 'A thin, unsupported guess.',
    citedFactIds: [],
  });
  const R1_VERIFY = JSON.stringify({
    verdict: 'unsupported',
    unsupportedClaims: ['A thin, unsupported guess.'],
    questionAnswered: false,
  });
  const L3_ANSWER = 'The tier is sapphire-crest, per the full session.';

  async function l3Count(app: AppFixture, outcome: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`brain_l3_escalation_total\\{outcome="${outcome}"\\} (\\d+)`));
    return m ? parseInt(m[1]!, 10) : 0;
  }

  beforeAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    f = await createApp();
    f2 = await createApp();

    // Anchored fact.
    const a = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'cust_l3_anchor' },
        predicate: 'tier',
        object: ANCHOR_OBJECT,
        validFrom: new Date('2026-04-01').toISOString(),
        source: { vertical: 'rent', messageId: 'm_l3_a' },
        confidence: 0.9,
      });
    anchoredFactId = a.body.factId;
    expect(anchoredFactId).toBeTruthy();

    // Non-anchored fact on the ISOLATED tenant.
    const b = await f2.http
      .post('/v1/ingest/fact')
      .set(auth2())
      .send({
        entityRef: { vertical: 'rent', id: 'cust_l3_lonely' },
        predicate: 'status',
        object: LONELY_OBJECT,
        validFrom: new Date('2026-04-02').toISOString(),
        source: { vertical: 'rent', messageId: 'm_l3_b' },
        confidence: 0.9,
      });
    expect(b.body.factId).toBeTruthy();

    // Create the anchoring episode session and link the fact to it.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE episode:l3ep1 CONTENT {
           kind: 'turn', messageId: 'm_l3_a', conversationId: 'conv_l3',
           speaker: 'user', text: $t1, occurredAt: $o1, source: {}
         };
         CREATE episode:l3ep2 CONTENT {
           kind: 'turn', messageId: 'm_l3_a2', conversationId: 'conv_l3',
           speaker: 'assistant', text: $t2, occurredAt: $o2, source: {}
         }`,
        {
          t1: `My tier is ${ANCHOR_OBJECT}, I confirmed it last week.`,
          t2: `Understood — you are on ${ANCHOR_OBJECT}.`,
          o1: new Date('2026-04-01T10:00:00Z'),
          o2: new Date('2026-04-01T10:01:00Z'),
        },
      );
      await db.query(`UPDATE $rid SET source.episodeIds = ['episode:l3ep1', 'episode:l3ep2']`, {
        rid: new StringRecordId(anchoredFactId),
      });
    });
  });

  afterAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    if (f) await f.close();
    if (f2) await f2.close();
  });

  it('flag off → no L3 call, normal verifier-failed abstention', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '0';
    const before = await l3Count(f, 'fired');
    const state = mockSynthesizeOpenAi(f.app, [R1_GEN, R1_VERIFY, '{}', '{}']);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // Strict guardrails + unsupported verdict → answer withheld.
    expect(res.body.answer).toBeNull();
    // Only round-1 generate + verify ran; the L3 lane never fired.
    expect(state.calls.length).toBe(2);
    expect(await l3Count(f, 'fired')).toBe(before);
  });

  it('flag on + verifier-fail + anchor + scripted L3 pass → L3 answer, metric flipped', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    const firedBefore = await l3Count(f, 'fired');
    const flippedBefore = await l3Count(f, 'flipped');
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [anchoredFactId] }),
      JSON.stringify({
        verdict: 'supported',
        unsupportedClaims: [],
        questionAnswered: true,
      }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(L3_ANSWER);
    // round-1 generate + verify, then L3 generate + verify.
    expect(state.calls.length).toBe(4);
    // The L3 generator saw the raw session turns (fenced-section style).
    expect(state.calls[2]!.user).toContain('Full conversation transcripts');
    expect(state.calls[2]!.user).toContain('conv_l3');
    expect(await l3Count(f, 'fired')).toBe(firedBefore + 1);
    expect(await l3Count(f, 'flipped')).toBe(flippedBefore + 1);
  });

  it('flag on + no anchoring session → abstain, no L3 call, metric skipped_no_anchor', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    const skipBefore = await l3Count(f2, 'skipped_no_anchor');
    const state = mockSynthesizeOpenAi(f2.app, [R1_GEN, R1_VERIFY, '{}', '{}']);
    const res = await f2.http
      .post('/v1/synthesize')
      .set(auth2())
      .send({ query: LONELY_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBeNull();
    // Trigger fired but no session anchor → no generation escalation.
    expect(state.calls.length).toBe(2);
    expect(await l3Count(f2, 'skipped_no_anchor')).toBe(skipBefore + 1);
  });
});
