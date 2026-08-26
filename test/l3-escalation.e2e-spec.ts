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

  async function counter(app: AppFixture, name: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`^${name} (\\d+)`, 'm'));
    return m ? parseInt(m[1]!, 10) : 0;
  }

  async function anchorSourceCount(app: AppFixture, source: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`brain_l3_anchor_source_total\\{source="${source}"\\} (\\d+)`));
    return m ? parseInt(m[1]!, 10) : 0;
  }

  async function episodeCitationCount(app: AppFixture, outcome: string): Promise<number> {
    const metrics = app.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(
      new RegExp(`brain_l3_episode_citation_total\\{outcome="${outcome}"\\} (\\d+)`),
    );
    return m ? parseInt(m[1]!, 10) : 0;
  }

  // A flipping L3 re-verification (supported + answering).
  const L3_VERIFY_PASS = JSON.stringify({
    verdict: 'supported',
    unsupportedClaims: [],
    questionAnswered: true,
  });
  const JUDGE_IMPLAUSIBLE = JSON.stringify({
    plausible: false,
    rationale: 'the cited transcript premise is a sandbox-only counterfactual',
  });

  beforeAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    delete process.env.RETRIEVAL_L3_DIRECT_ANCHOR;
    delete process.env.RETRIEVAL_L3_SEGMENT_ANCHOR;
    delete process.env.RETRIEVAL_L3_TEMPORAL_ANCHOR;
    f = await createApp();
    // Extra key WITHOUT brain:read_pii — the aux-anchor PII fence case.
    f2 = await createApp({ extraKeys: [{ scopes: ['brain:read', 'brain:write'] }] });

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

    // More non-anchored facts (ISOLATED tenant), one per aux-anchor e2e
    // query — synthesize returns no_results BEFORE the L3 seam when
    // retrieval is empty, so each query must retrieve SOMETHING; none of
    // these carries source.episodeIds, so the fact path still resolves
    // zero anchors.
    for (const [id, predicate, object] of [
      ['cust_l3_fence', 'ledger', 'nickel-slate'],
      ['cust_l3_pii', 'passphrase', 'opal-thorn'],
      ['cust_l3_relay', 'status', 'relay-bank'],
    ] as const) {
      const r = await f2.http
        .post('/v1/ingest/fact')
        .set(auth2())
        .send({
          entityRef: { vertical: 'rent', id },
          predicate,
          object,
          validFrom: new Date('2026-04-02').toISOString(),
          source: { vertical: 'rent', messageId: `m_${id}` },
          confidence: 0.9,
        });
      expect(r.body.factId).toBeTruthy();
    }

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

    // L3 anchor independence seeds (ISOLATED tenant — no fact names any
    // of these sessions, so the fact path keeps resolving zero anchors):
    //  - conv_l3_direct: global searchable session (direct-anchor case);
    //  - conv_l3_usera:  user-A-scoped session (user fence case);
    //  - conv_l3_pii:    PII-classed session (read_pii fence case);
    //  - conv_l3_april:  April-2026 session (temporal-anchor case; the
    //    other seeds sit in March so the period isolates it).
    const surreal2 = f2.app.get(SurrealService);
    await surreal2.withCompany(f2.companyId, async (db) => {
      await db.query(
        `CREATE episode:l3d1 CONTENT {
           kind: 'turn', messageId: 'm_l3_d1', conversationId: 'conv_l3_direct',
           speaker: 'user', text: $d1, occurredAt: $mar1, source: {}
         };
         CREATE episode:l3d2 CONTENT {
           kind: 'turn', messageId: 'm_l3_d2', conversationId: 'conv_l3_direct',
           speaker: 'assistant', text: $d2, occurredAt: $mar2, source: {}
         };
         CREATE episode:l3u1 CONTENT {
           kind: 'turn', messageId: 'm_l3_u1', conversationId: 'conv_l3_usera',
           speaker: 'user', text: $u1, occurredAt: $mar1, userId: 'user-a', source: {}
         };
         CREATE episode:l3p1 CONTENT {
           kind: 'turn', messageId: 'm_l3_p1', conversationId: 'conv_l3_pii',
           speaker: 'user', text: $p1, occurredAt: $mar1, piiClass: ['contact'], source: {}
         };
         CREATE episode:l3t1 CONTENT {
           kind: 'turn', messageId: 'm_l3_t1', conversationId: 'conv_l3_april',
           speaker: 'user', text: $t1, occurredAt: $apr1, source: {}
         };
         CREATE episode:l3t2 CONTENT {
           kind: 'turn', messageId: 'm_l3_t2', conversationId: 'conv_l3_april',
           speaker: 'assistant', text: $t2, occurredAt: $apr2, source: {}
         }`,
        {
          d1: `what is the status meridian-blue-l3 — you asked me to log it.`,
          d2: `the status meridian-blue-l3 is what we call dormant standby.`,
          u1: `my nickel-slate ledger balance is 42 entries.`,
          p1: `the opal-thorn passphrase vault code is 9142.`,
          t1: `we rewired the meridian relay bank this week.`,
          t2: `confirmed — the relay bank cutover is complete.`,
          mar1: new Date('2026-03-05T10:00:00Z'),
          mar2: new Date('2026-03-05T10:01:00Z'),
          apr1: new Date('2026-04-03T09:00:00Z'),
          apr2: new Date('2026-04-04T09:00:00Z'),
        },
      );
    });
  });

  afterEach(() => {
    delete process.env.FOVEA_PLAUSIBILITY_CHECK;
    delete process.env.FOVEA_REQUIRE_CITATIONS;
    delete process.env.FOVEA_L3_EPISODE_CITATIONS;
    delete process.env.RETRIEVAL_L3_DIRECT_ANCHOR;
    delete process.env.RETRIEVAL_L3_SEGMENT_ANCHOR;
    delete process.env.RETRIEVAL_L3_TEMPORAL_ANCHOR;
  });

  afterAll(async () => {
    delete process.env.RETRIEVAL_L3_ESCALATION;
    delete process.env.RETRIEVAL_L3_DIRECT_ANCHOR;
    delete process.env.RETRIEVAL_L3_SEGMENT_ANCHOR;
    delete process.env.RETRIEVAL_L3_TEMPORAL_ANCHOR;
    delete process.env.FOVEA_PLAUSIBILITY_CHECK;
    delete process.env.FOVEA_REQUIRE_CITATIONS;
    delete process.env.FOVEA_L3_EPISODE_CITATIONS;
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

  // ── Answer-integrity gate on the L3 flip path ─────────────────────
  // The L3 answer grounds on the RAW TRANSCRIPT, so it MUST pass through the
  // same default-off Part A + Part C guards as the primary serve.

  it('L3 flip + FOVEA_PLAUSIBILITY_CHECK on + implausible judge → downgraded to abstain (not served)', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_PLAUSIBILITY_CHECK = '1';
    const flippedBefore = await l3Count(f, 'flipped');
    const downgradeBefore = await counter(f, 'brain_plausibility_downgrade_total');
    // gen → verify(fail) → L3 gen(cited) → L3 verify(pass) → plausibility judge.
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [anchoredFactId] }),
      L3_VERIFY_PASS,
      JUDGE_IMPLAUSIBLE,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // The L3 supported answer is withheld — abstain instead of serving the
    // belief-distorted, transcript-grounded answer.
    expect(res.body.answer).not.toBe(L3_ANSWER);
    expect(res.body.reason).toBe('low_coverage');
    expect(res.body.citations ?? []).toEqual([]);
    // The L3 still flipped (the ladder is untouched); the gate ran AFTER.
    expect(await l3Count(f, 'flipped')).toBe(flippedBefore + 1);
    // The fifth call is the plausibility auditor over the L3 answer's premise.
    expect(state.calls.length).toBe(5);
    expect(state.calls[4]!.system).toContain('plausibility auditor');
    expect(await counter(f, 'brain_plausibility_downgrade_total')).toBe(downgradeBefore + 1);
  });

  it('L3 flip + FOVEA_REQUIRE_CITATIONS on + uncited L3 answer → abstain', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_REQUIRE_CITATIONS = '1';
    const flippedBefore = await l3Count(f, 'flipped');
    const guardBefore = await counter(f, 'brain_citation_guard_abstain_total');
    // The L3 raw-transcript answer is UNCITED by design; require-citations then
    // abstains it (the correct end-to-end reading of the citation promise). No
    // plausibility judge — Part C is a pure post-verdict decision → 4 calls.
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [] as string[] }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).not.toBe(L3_ANSWER);
    expect(res.body.reason).toBe('low_coverage');
    expect(res.body.citations ?? []).toEqual([]);
    expect(await l3Count(f, 'flipped')).toBe(flippedBefore + 1);
    expect(state.calls.length).toBe(4);
    expect(await counter(f, 'brain_citation_guard_abstain_total')).toBe(guardBefore + 1);
  });

  it('both integrity flags off → L3 serves byte-identical (cited answer, no reason, no extra call)', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    // FOVEA_PLAUSIBILITY_CHECK + FOVEA_REQUIRE_CITATIONS both unset (afterEach).
    const flippedBefore = await l3Count(f, 'flipped');
    const downgradeBefore = await counter(f, 'brain_plausibility_downgrade_total');
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [anchoredFactId] }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // The L3 answer serves exactly as before, with its citation intact.
    expect(res.body.answer).toBe(L3_ANSWER);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.citations?.map((c: { factId: string }) => c.factId)).toContain(anchoredFactId);
    // Exactly gen + verify + L3 gen + L3 verify — NO fifth (judge) call.
    expect(state.calls.length).toBe(4);
    expect(await l3Count(f, 'flipped')).toBe(flippedBefore + 1);
    expect(await counter(f, 'brain_plausibility_downgrade_total')).toBe(downgradeBefore);
  });

  // ── L3 anchor independence: aux anchor sources on the empty-fact-
  // anchor residual (skipped_no_anchor becomes "every enabled source
  // came up empty"). All on the ISOLATED tenant, whose facts never
  // name a session.

  it('aux: zero fact anchors + RETRIEVAL_L3_DIRECT_ANCHOR → fires off a BM25 episode anchor', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.RETRIEVAL_L3_DIRECT_ANCHOR = '1';
    const firedBefore = await l3Count(f2, 'fired');
    const directBefore = await anchorSourceCount(f2, 'direct');
    const answer = 'The status is dormant standby, per the raw session.';
    const state = mockSynthesizeOpenAi(f2.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer, citedFactIds: [] as string[] }),
      L3_VERIFY_PASS,
    ]);
    const res = await f2.http
      .post('/v1/synthesize')
      .set(auth2())
      .send({ query: LONELY_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(answer);
    // round-1 generate + verify, then L3 generate + verify.
    expect(state.calls.length).toBe(4);
    // The L3 generator saw the BM25-anchored raw session.
    expect(state.calls[2]!.user).toContain('Full conversation transcripts');
    expect(state.calls[2]!.user).toContain('conv_l3_direct');
    expect(await l3Count(f2, 'fired')).toBe(firedBefore + 1);
    expect(await anchorSourceCount(f2, 'direct')).toBe(directBefore + 1);
  });

  it('aux fence: dto.userId=B never anchors off user-A episodes → skipped_no_anchor', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.RETRIEVAL_L3_DIRECT_ANCHOR = '1';
    const skipBefore = await l3Count(f2, 'skipped_no_anchor');
    const state = mockSynthesizeOpenAi(f2.app, [R1_GEN, R1_VERIFY, '{}', '{}']);
    const res = await f2.http
      .post('/v1/synthesize')
      .set(auth2())
      .send({ query: 'nickel-slate ledger balance', userId: 'user-b', limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBeNull();
    // The only matching episode is user-A's — fenced out, no L3 call.
    expect(state.calls.length).toBe(2);
    expect(await l3Count(f2, 'skipped_no_anchor')).toBe(skipBefore + 1);
  });

  it('aux fence: PII-classed episodes anchor only with brain:read_pii', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.RETRIEVAL_L3_DIRECT_ANCHOR = '1';
    const query = 'opal-thorn passphrase vault';
    // Key WITHOUT read_pii: the only matching episode is PII-classed →
    // fenced out → skipped_no_anchor, no L3 call.
    const skipBefore = await l3Count(f2, 'skipped_no_anchor');
    const restricted = mockSynthesizeOpenAi(f2.app, [R1_GEN, R1_VERIFY, '{}', '{}']);
    const resA = await f2.http
      .post('/v1/synthesize')
      .set({ Authorization: `Bearer ${f2.extraApiKeys[0]}` })
      .send({ query, limit: 5 });
    expect(resA.status).toBe(201);
    expect(resA.body.answer).toBeNull();
    expect(restricted.calls.length).toBe(2);
    expect(await l3Count(f2, 'skipped_no_anchor')).toBe(skipBefore + 1);
    // Same query with the read_pii key: the episode anchors and L3 fires.
    const firedBefore = await l3Count(f2, 'fired');
    const answer = 'The vault code is 9142, per the raw session.';
    const full = mockSynthesizeOpenAi(f2.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer, citedFactIds: [] as string[] }),
      L3_VERIFY_PASS,
    ]);
    const resB = await f2.http.post('/v1/synthesize').set(auth2()).send({ query, limit: 5 });
    expect(resB.status).toBe(201);
    expect(resB.body.answer).toBe(answer);
    expect(full.calls.length).toBe(4);
    expect(full.calls[2]!.user).toContain('conv_l3_pii');
    expect(await l3Count(f2, 'fired')).toBe(firedBefore + 1);
  });

  it('aux: RETRIEVAL_L3_TEMPORAL_ANCHOR anchors conversations in the query-named period', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.RETRIEVAL_L3_TEMPORAL_ANCHOR = '1';
    const firedBefore = await l3Count(f2, 'fired');
    const temporalBefore = await anchorSourceCount(f2, 'temporal');
    const answer = 'The relay bank cutover completed in April 2026.';
    const state = mockSynthesizeOpenAi(f2.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer, citedFactIds: [] as string[] }),
      L3_VERIFY_PASS,
    ]);
    const res = await f2.http
      .post('/v1/synthesize')
      .set(auth2())
      .send({ query: 'what changed at the relay bank in April 2026', limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(answer);
    expect(state.calls.length).toBe(4);
    // Only the April session is in-period (the other seeds sit in March).
    expect(state.calls[2]!.user).toContain('conv_l3_april');
    expect(state.calls[2]!.user).not.toContain('conv_l3_direct');
    expect(await l3Count(f2, 'fired')).toBe(firedBefore + 1);
    expect(await anchorSourceCount(f2, 'temporal')).toBe(temporalBefore + 1);
  });

  // ── L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS) ────────────
  // Gap #4: rule 2's transcript-citation exemption. Flag on, transcript-
  // grounded claims cite {episodeId, quote} pairs resolved into
  // span-verified evidence citations; flag off is pinned byte-identical.

  // The historical L3 system prompt, pinned byte-for-byte: any flag-off
  // drift in the prompt (rule 2's exemption included) fails here.
  const L3_SYSTEM_PINNED = `You are an answer synthesizer with access to FULL raw conversation transcripts.

The extracted facts did not ground an answer, so you are given the complete raw sessions the relevant facts came from. Read the transcripts as the primary evidence and answer the user's query.
1. Use ONLY information present in the provided transcripts and facts. Do NOT speculate or use outside knowledge.
2. When a numbered fact supports a claim, inline its factId in square brackets EXACTLY as it appears (including the "knowledge_fact:" prefix) and mirror it into citedFactIds. Claims taken from the raw transcript need no citation.
3. If the transcripts do not answer the question, output the exact string "I don't have grounded evidence for that." with citedFactIds set to [].

Output strictly the JSON shape requested by the schema. No preamble, no chain-of-thought.`;

  /** The captured L3 request, narrowed to prompt + schema assertions. */
  interface CapturedL3Request {
    response_format: { json_schema: { schema: unknown } };
  }

  it('episode-citations flag OFF → L3 prompt + schema + transcript lines byte-identical (pinned)', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({ answer: L3_ANSWER, citedFactIds: [anchoredFactId] }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(L3_ANSWER);
    // No evidenceCitations field is ever emitted with the flag off.
    expect(res.body.evidenceCitations).toBeUndefined();
    // The system prompt is the historical one, byte-for-byte.
    expect(state.calls[2]!.system).toBe(L3_SYSTEM_PINNED);
    // The strict JSON schema is the historical two-field shape.
    const req = state.calls[2]!.request as CapturedL3Request;
    expect(req.response_format.json_schema.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        citedFactIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['answer', 'citedFactIds'],
    });
    // And the transcript lines carry no [episode:...] headers.
    expect(state.calls[2]!.user).not.toContain('[episode:');
  });

  it('flag ON → [episode:...] headers; citedEpisodes → evidenceCitations end-to-end; hallucinated id never surfaces', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_L3_EPISODE_CITATIONS = '1';
    const spanBefore = await episodeCitationCount(f, 'span_anchored');
    const droppedBefore = await episodeCitationCount(f, 'dropped_unknown');
    const quote = `My tier is ${ANCHOR_OBJECT}`;
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({
        answer: L3_ANSWER,
        citedFactIds: [anchoredFactId],
        citedEpisodes: [
          { episodeId: 'episode:l3ep1', quote },
          // A hallucinated id — never rendered into the transcript, must
          // be dropped by the fence and never surface in the response.
          { episodeId: 'episode:ghost_l3', quote: 'anything' },
        ],
      }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(L3_ANSWER);
    // The transcript lines carry the per-turn episode headers.
    expect(state.calls[2]!.user).toContain('[episode:l3ep1]');
    expect(state.calls[2]!.user).toContain('[episode:l3ep2]');
    // The fact citation is untouched; the evidence citation resolved with
    // a verified code-point span over the stored turn text.
    expect(res.body.citations.map((c: { factId: string }) => c.factId)).toContain(anchoredFactId);
    expect(res.body.evidenceCitations).toEqual([
      {
        episodeId: 'episode:l3ep1',
        conversationId: 'conv_l3',
        occurredAt: '2026-04-01T10:00:00.000Z',
        span: { start: 0, end: [...quote].length, exact: quote },
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('ghost_l3');
    expect(await episodeCitationCount(f, 'span_anchored')).toBe(spanBefore + 1);
    expect(await episodeCitationCount(f, 'dropped_unknown')).toBe(droppedBefore + 1);
  });

  it('FOVEA_REQUIRE_CITATIONS + zero fact citations + ≥1 evidence citation → SERVES', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_L3_EPISODE_CITATIONS = '1';
    process.env.FOVEA_REQUIRE_CITATIONS = '1';
    const guardBefore = await counter(f, 'brain_citation_guard_abstain_total');
    const quote = `you are on ${ANCHOR_OBJECT}`;
    const state = mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({
        answer: L3_ANSWER,
        citedFactIds: [] as string[],
        citedEpisodes: [{ episodeId: 'episode:l3ep2', quote }],
      }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    // Episode-cited ⇒ the require-citations guard counts it as cited.
    expect(res.body.answer).toBe(L3_ANSWER);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.citations).toEqual([]);
    expect(res.body.evidenceCitations).toHaveLength(1);
    expect(res.body.evidenceCitations[0].episodeId).toBe('episode:l3ep2');
    expect(state.calls.length).toBe(4);
    expect(await counter(f, 'brain_citation_guard_abstain_total')).toBe(guardBefore);
  });

  it('FOVEA_REQUIRE_CITATIONS + zero of BOTH → abstains, and the abstain carries no evidenceCitations', async () => {
    process.env.RETRIEVAL_L3_ESCALATION = '1';
    process.env.FOVEA_L3_EPISODE_CITATIONS = '1';
    process.env.FOVEA_REQUIRE_CITATIONS = '1';
    const guardBefore = await counter(f, 'brain_citation_guard_abstain_total');
    mockSynthesizeOpenAi(f.app, [
      R1_GEN,
      R1_VERIFY,
      JSON.stringify({
        answer: L3_ANSWER,
        citedFactIds: [] as string[],
        citedEpisodes: [] as Array<{ episodeId: string; quote: string }>,
      }),
      L3_VERIFY_PASS,
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: ANCHOR_QUERY, limit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.answer).not.toBe(L3_ANSWER);
    expect(res.body.reason).toBe('low_coverage');
    expect(res.body.citations ?? []).toEqual([]);
    expect(res.body.evidenceCitations).toBeUndefined();
    expect(await counter(f, 'brain_citation_guard_abstain_total')).toBe(guardBefore + 1);
  });
});
