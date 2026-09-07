/**
 * SCENES_PREDICTION_BASELINE e2e on real SurrealDB (stubbed model — no
 * paid calls): the controlled experiment the whole PR exists to make
 * possible. TWO scenes with BYTE-IDENTICAL transcripts and the SAME
 * stubbed enrichment reply, belonging to two different users whose
 * seeded beliefs differ in exactly one value — one agrees with the
 * scene's stateDelta, one contradicts it. Free-floating saliency cannot
 * tell them apart (same text, same model output); a measured prediction
 * error must.
 *
 * Also pins: the flag-off world (v1 composite, no baselineRef, the
 * model's guess verbatim), the re-enrichment a flag flip triggers via
 * the composite, the stamped baselineRef snapshot, and cross-user
 * isolation — each scene's baseline holds ONLY its own user's belief.
 *
 * Beliefs are seeded directly in the DB (the belief-promotion e2e
 * precedent): the promotion pass has its own suite, and hand-seeded rows
 * make the expectation deterministic.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSceneEnricherOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

const CONV_AGREE = 'proj:pred-agree';
const CONV_DISAGREE = 'proj:pred-disagree';
const USER_AGREE = 'pred_agree_user';
const USER_DISAGREE = 'pred_disagree_user';

/** Identical in both conversations — the only variable is the belief. */
const TURNS = [
  { t: '2026-03-01T10:00:00.000Z', text: 'I am moving to Lisbon next month.' },
  { t: '2026-03-01T10:05:00.000Z', text: 'Signed the lease in Lisbon today.' },
  { t: '2026-03-01T10:10:00.000Z', text: 'Everything is set now.' },
];

/**
 * One stubbed reply for every scene. The model GUESSES contradiction
 * 0.42 with no idea what was believed before — exactly the saliency
 * guess this PR replaces.
 */
const REPLY = JSON.stringify({
  gist: 'Mika signed the Lisbon lease and the move is settled.',
  memoryValue: {
    novelty: 0.8,
    contradiction: 0.42,
    stateChange: 0.1,
    identity: 0.1,
    explicitness: 0.9,
    estimatedUtility: 0.7,
  },
  stateDeltas: [{ subject: 'Lisbon', field: 'lease', from: '', to: 'signed' }],
  unexpectedDetails: ['signed the lease the same week'],
  entityMentions: ['Lisbon'],
});

interface SceneRow {
  id: unknown;
  userId?: string;
  conversationIds: string[];
  memoryValue?: Record<string, unknown>;
  enrichedMemoryValue?: Record<string, unknown>;
  enrichmentVersion?: string;
  enrichmentModel?: string;
  baselineRef?: { beliefs?: Array<Record<string, unknown>>; baselineVersion?: string };
}

describe('scene prediction baseline (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  const FLAGS = [
    'EPISODE_SUBSTRATE_ENABLED',
    'INGEST_EPISODE_ONLY',
    'SCENES_SEGMENTATION_ENABLED',
    'SCENES_LLM_ENRICHMENT',
    'SCENES_PREDICTION_BASELINE',
  ];

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const scenes = (): Promise<SceneRow[]> =>
    db(async (d) => {
      const [rows] = await d.query<[SceneRow[]]>(
        `SELECT * FROM memory_episode ORDER BY userId ASC`,
      );
      return rows ?? [];
    });

  const sceneOf = async (userId: string): Promise<SceneRow> => {
    const row = (await scenes()).find((s) => s.userId === userId);
    expect(row).toBeDefined();
    return row!;
  };

  const seedBelief = (tail: string, userId: string, value: string): Promise<unknown> =>
    db(async (d) =>
      d.query(
        `CREATE type::record('semantic_belief', $tail) CONTENT {
           userId: $userId,
           subject: 'Lisbon',
           field: 'lease',
           value: $value,
           statement: $statement,
           statementSource: 'template',
           confidence: 0.8,
           revision: 1,
           status: 'active',
           validFrom: <datetime>'2026-01-01T00:00:00Z',
           sourceSceneIds: [],
           conversationIds: [],
           corroborationCount: 1,
           conversationCount: 1,
           promoterVersion: 'test-seed'
         }`,
        { tail, userId, value, statement: `Lisbon — lease: ${value}` },
      ),
    );

  const enrich = () => f.http.post('/v1/admin/maintenance/scenes/enrich').set(auth()).send({});

  beforeAll(async () => {
    for (const k of FLAGS) saved[k] = process.env[k];
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.INGEST_EPISODE_ONLY = '1';
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    // Both PR flags start OFF — each `it` flips only what it proves.
    delete process.env.SCENES_LLM_ENRICHMENT;
    delete process.env.SCENES_PREDICTION_BASELINE;
    f = await createApp({ companyId: 'co_scene_pred_e2e' });

    for (const [conv, userId] of [
      [CONV_AGREE, USER_AGREE],
      [CONV_DISAGREE, USER_DISAGREE],
    ] as const) {
      for (const [i, turn] of TURNS.entries()) {
        const res = await f.http
          .post('/v1/ingest/mention')
          .set(auth())
          .send({
            text: turn.text,
            contextRef: { vertical: 'proj', conversationId: conv, messageId: `${userId}${i}` },
            knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
            userId,
            emittedAt: turn.t,
          });
        expect(res.status).toBe(201);
      }
    }

    // The world model BEFORE the scenes: the same (subject, field) for
    // both users, differing in exactly one value.
    await seedBelief('pred_agree', USER_AGREE, 'signed');
    await seedBelief('pred_dis', USER_DISAGREE, 'cancelled');

    const composed = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(composed.status).toBe(201);
    expect(composed.body).toMatchObject({ conversations: 2, scenes: 2 });
  }, 120000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('composes single-user scenes with the deterministic v0 vector', async () => {
    const rows = await scenes();
    expect(rows).toHaveLength(2);
    for (const scene of rows) {
      expect(scene.memoryValue!.scorerVersion).toBe('scene-scorer-v0');
      // The v0 scorer leaves the prediction-error dimensions undefined.
      expect(scene.memoryValue!.contradiction).toBeUndefined();
      expect(scene.baselineRef).toBeUndefined();
    }
    expect(rows.map((s) => s.userId).sort()).toEqual([USER_AGREE, USER_DISAGREE]);
  });

  it('with the baseline OFF the model’s guess survives verbatim — no baselineRef', async () => {
    process.env.SCENES_LLM_ENRICHMENT = '1';
    const mock = mockSceneEnricherOpenAi(f.app, [REPLY]);
    const res = await enrich();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scenes: 2, enriched: 2, failed: 0, skipped: 0 });
    // No baseline block reached the model.
    for (const call of mock.calls) {
      expect(call.user).not.toContain('Current model of the world');
      expect(call.user.startsWith('Scene transcript:')).toBe(true);
    }
    for (const scene of await scenes()) {
      expect(scene.enrichedMemoryValue!.scorerVersion).toBe('scene-scorer-llm-v1');
      expect(scene.enrichedMemoryValue!.contradiction).toBeCloseTo(0.42);
      expect(scene.enrichmentVersion).toBe(
        `scene-gist-v1|scene-scorer-llm-v1|${scene.enrichmentModel!}`,
      );
      expect(scene.baselineRef).toBeUndefined();
    }
  });

  it('flipping the baseline ON changes the composite, so the world re-enriches', async () => {
    process.env.SCENES_PREDICTION_BASELINE = '1';
    const mock = mockSceneEnricherOpenAi(f.app, [REPLY]);
    const res = await enrich();
    expect(res.status).toBe(201);
    // The stamped v1 composite no longer matches ⇒ nothing is skipped.
    expect(res.body).toMatchObject({ scenes: 2, enriched: 2, failed: 0, skipped: 0 });
    expect(mock.calls).toHaveLength(2);
    // Each scene saw its OWN user's world model, and only that.
    const blocks = mock.calls.map((c) => c.user);
    expect(blocks.filter((b) => b.includes('Lisbon | lease = signed'))).toHaveLength(1);
    expect(blocks.filter((b) => b.includes('Lisbon | lease = cancelled'))).toHaveLength(1);
    for (const block of blocks) {
      expect(block).toContain('Current model of the world');
      // Cross-user isolation: never both values in one prompt.
      expect(block.includes('signed') && block.includes('cancelled')).toBe(false);
    }
  });

  it('MEASURES surprise: the contradicting scene scores far above the agreeing one', async () => {
    const agree = await sceneOf(USER_AGREE);
    const disagree = await sceneOf(USER_DISAGREE);

    // Identical transcripts, identical model reply, identical guess —
    // the ONLY difference is what the system believed beforehand.
    expect(agree.enrichedMemoryValue!.contradiction).toBe(0);
    expect(disagree.enrichedMemoryValue!.contradiction).toBe(1);
    expect(
      (disagree.enrichedMemoryValue!.contradiction as number) -
        (agree.enrichedMemoryValue!.contradiction as number),
    ).toBeGreaterThan(0.5);

    for (const scene of [agree, disagree]) {
      // Both producers are named on the vector.
      expect(scene.enrichedMemoryValue!.scorerVersion).toBe('scene-scorer-llm-v1+scene-scorer-v1');
      expect(scene.enrichmentVersion).toBe(
        `scene-gist-v2|scene-scorer-llm-v1+scene-scorer-v1|${scene.enrichmentModel!}`,
      );
      // Deterministic, baseline-free dimensions: 1 delta over 3 turns.
      expect(scene.enrichedMemoryValue!.stateChange).toBeCloseTo(2 / 3);
      // The delta is about a place, not the speaker.
      expect(scene.enrichedMemoryValue!.identity).toBe(0);
      // Dimensions the scorer cannot measure stay the model's.
      expect(scene.enrichedMemoryValue!.novelty).toBeCloseTo(0.8);
      expect(scene.enrichedMemoryValue!.estimatedUtility).toBeCloseTo(0.7);
      // The composer's deterministic vector is untouched (0118).
      expect(scene.memoryValue!.scorerVersion).toBe('scene-scorer-v0');
      expect(scene.memoryValue!.contradiction).toBeUndefined();
    }
  });

  it('stamps the expectation snapshot as baselineRef, per user', async () => {
    const agree = await sceneOf(USER_AGREE);
    const disagree = await sceneOf(USER_DISAGREE);
    expect(agree.baselineRef!.baselineVersion).toBe('scene-baseline-v1');
    expect(agree.baselineRef!.beliefs).toMatchObject([
      { subject: 'Lisbon', field: 'lease', value: 'signed', revision: 1 },
    ]);
    expect(disagree.baselineRef!.beliefs).toMatchObject([
      { subject: 'Lisbon', field: 'lease', value: 'cancelled', revision: 1 },
    ]);
    // A scene never carries another user's belief id.
    expect(String(agree.baselineRef!.beliefs![0]!.id)).toContain('pred_agree');
    expect(String(disagree.baselineRef!.beliefs![0]!.id)).toContain('pred_dis');
  });

  it('re-enrichment with the baseline on is idempotent — zero paid calls', async () => {
    const mock = mockSceneEnricherOpenAi(f.app, [REPLY]);
    const res = await enrich();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scenes: 2, enriched: 0, failed: 0, skipped: 2 });
    expect(mock.calls).toHaveLength(0);
  });
});
