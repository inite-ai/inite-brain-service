/**
 * Scene serving lane e2e (RETRIEVAL_SCENE_LANE) over a real SurrealDB
 * (testcontainer) — the episodic plane's FIRST serving read, end to end
 * over a world the composer actually built.
 *
 * Substrate: one conversation of USER turns about a lease scan, ingested
 * episode-only, segmented by the real composer (embedder-free — no paid
 * calls anywhere in this suite), plus one tenant-global fact so every
 * fence variant still has something to synthesize from.
 *
 * Pins:
 *   1. REGISTRY PROMOTION (the composer's :128-130 contract): with the
 *      lane off the world registers 'built' — the pre-lane behavior; with
 *      the lane on the SAME composer run registers it 'live'. The read
 *      lane the old comment waited for now exists, so activation is real;
 *   2. CONTROL (lane off): NO episodic section in the generator or
 *      verifier prompt, no evidenceCitations — byte-identical serving
 *      with the substrate fully built and promoted;
 *   3. lane ON: the scene line renders for generator AND verifier
 *      (evidence parity), headed by its [memory_episode:...] id with the
 *      UTC span; the scripted generator cites it ⇒ a scene-arm evidence
 *      citation whose excerpt IS the rendered gist, with a hallucinated
 *      id dropped by the rendered-set fence;
 *   4. FENCES: a CROSS-USER caller gets NO scene line (and no scene
 *      citation is resolvable), and an UNSCOPED caller gets none either
 *      — the lane is scoped-user-only;
 *   5. an unpromoted world does not serve: demote the registry row and
 *      the lane goes empty with the flag still on.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

const CONV = 'proj:scene-serving';
const USER = 'scene_serving_u1';
const OTHER_USER = 'scene_serving_u2';
const QUERY = 'what happened with the lease scan?';
const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });

const FLAG_KEYS = ['RETRIEVAL_SCENE_LANE'] as const;

describe('Scene serving lane e2e (the episodic plane’s first read)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  let sceneId = '';
  let sceneGist = '';
  let factId = '';

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  const projectionRows = () =>
    db(async (d) => {
      const [rows] = await d.query<[Array<{ version: string; status: string }>]>(
        `SELECT version, status FROM projection WHERE name = 'scenes'`,
      );
      return rows ?? [];
    });

  const compose = async () => {
    const res = await f.http.post('/v1/admin/maintenance/scenes').set(auth()).send({});
    expect(res.status).toBe(201);
    return res.body as { conversations: number; scenes: number };
  };

  beforeAll(async () => {
    for (const k of [
      ...FLAG_KEYS,
      'EPISODE_SUBSTRATE_ENABLED',
      'INGEST_EPISODE_ONLY',
      'SCENES_SEGMENTATION_ENABLED',
      'SCENES_TOPIC_BOUNDARY',
      'RETRIEVAL_ABSTENTION_CALIBRATION',
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.INGEST_EPISODE_ONLY = '1';
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    // Embedder-free segmentation: session-gap + max-turns only.
    delete process.env.SCENES_TOPIC_BOUNDARY;
    // Pin abstention off so a thin-evidence query never pre-abstains
    // before generation (the 0113 e2e discipline).
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    f = await createApp({ companyId: 'co_scene_serving_e2e' });

    // One session of USER turns — the scene the lane must find.
    const turns = [
      { t: '2026-07-01T10:00:00.000Z', text: 'Here is the signed lease scan for the flat.' },
      { t: '2026-07-01T10:01:00.000Z', text: 'The landlord countersigned it yesterday.' },
      { t: '2026-07-01T10:02:00.000Z', text: 'Filed the lease scan in the tenancy folder.' },
    ];
    for (const [i, turn] of turns.entries()) {
      const res = await f.http
        .post('/v1/ingest/mention')
        .set(auth())
        .send({
          text: turn.text,
          contextRef: { vertical: 'proj', conversationId: CONV, messageId: `ss${i}` },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          userId: USER,
          emittedAt: turn.t,
        });
      expect(res.status).toBe(201);
    }

    // A tenant-global fact so every fence variant has fact evidence and
    // the generator is never left with an empty prompt.
    const fact = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'proj', id: 'flat-lease' },
        predicate: 'code_memory__decided',
        object: 'the flat lease was signed',
        validFrom: new Date('2026-07-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'proj', recorder: 'bot' },
      });
    expect([200, 201]).toContain(fact.status);
    factId = fact.body.factId as string;
    expect(factId).toBeTruthy();
  }, 180000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('registry promotion: lane OFF ⇒ the world registers "built", never "live"', async () => {
    delete process.env.RETRIEVAL_SCENE_LANE;
    const run = await compose();
    expect(run).toMatchObject({ conversations: 1 });
    expect(run.scenes).toBeGreaterThanOrEqual(1);
    const rows = await projectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('built');
  });

  it('registry promotion: lane ON ⇒ the SAME composer run registers the world "live"', async () => {
    process.env.RETRIEVAL_SCENE_LANE = '1';
    await compose();
    const rows = await projectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('live');
    delete process.env.RETRIEVAL_SCENE_LANE;

    // The scene the lane will serve — stamped to this user by the
    // composer's own scope fold (one user's turns ⇒ userId set).
    const scenes = await db(async (d) => {
      // `occurredFrom` rides the projection: SurrealDB 3.x requires the
      // ORDER BY idiom to be a selected field.
      const [rows2] = await d.query<
        [Array<{ id: unknown; gist: string; userId?: string; userIds?: string[] }>]
      >(
        `SELECT id, gist, userId, userIds, occurredFrom FROM memory_episode
          ORDER BY occurredFrom ASC`,
      );
      return rows2 ?? [];
    });
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.userId).toBe(USER);
    expect(scenes[0]!.userIds).toEqual([USER]);
    sceneId = String(scenes[0]!.id);
    sceneGist = scenes[0]!.gist;
    expect(sceneGist).toContain('lease scan');
  });

  it('CONTROL — lane off: no episodic section, no evidenceCitations (byte-identical serving)', async () => {
    delete process.env.RETRIEVAL_SCENE_LANE;
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: `The flat lease was signed [${factId}].`,
        citedFactIds: [factId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: USER });
    expect(res.status).toBe(201);
    expect(res.body.evidenceCitations).toBeUndefined();
    expect(state.calls.length).toBe(2);
    // The substrate is built AND promoted, yet nothing reaches the prompt.
    expect(state.calls[0]!.user).not.toContain('Episodic record');
    expect(state.calls[0]!.user).not.toContain('[memory_episode:');
    expect(state.calls[0]!.system).not.toContain('SCENE CITATIONS');
    expect(state.calls[0]!.system).not.toContain('SCENE LINES PRESERVE ABSTENTION');
    expect(state.calls[1]!.user).not.toContain('Episodic record');
  });

  it('lane ON: the scene renders for generator AND verifier; a cited scene ships a scene-arm citation', async () => {
    process.env.RETRIEVAL_SCENE_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: `The signed lease scan arrived and was filed [${factId}] [${sceneId}].`,
        citedFactIds: [factId],
        citedSceneIds: [sceneId, 'memory_episode:hallucinated'],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: USER });
    expect(res.status).toBe(201);
    // The rendered-set fence dropped the hallucinated id; the excerpt is
    // the RENDERED gist, never generator text.
    expect(res.body.evidenceCitations).toHaveLength(1);
    expect(res.body.evidenceCitations[0]).toMatchObject({ sceneId, excerpt: sceneGist });
    expect(res.body.evidenceCitations[0].beliefId).toBeUndefined();
    expect(res.body.evidenceCitations[0].capability).toBeUndefined();

    const genPrompt = state.calls[0]!.user;
    expect(genPrompt).toContain('Episodic record');
    expect(genPrompt).toContain(`[${sceneId}]`);
    expect(genPrompt).toContain(sceneGist);
    // The line carries the scene's UTC span, in the 0106 convention.
    expect(genPrompt).toContain(`[${sceneId}] (2026-07-01 10:00–10:02 UTC)`);
    expect(state.calls[0]!.system).toContain('SCENE CITATIONS');
    expect(state.calls[0]!.system).toContain('SCENE LINES PRESERVE ABSTENTION');
    // Evidence parity (W5 #22): the SAME line arrives at the auditor.
    const verifyPrompt = state.calls[1]!.user;
    expect(verifyPrompt).toContain('Episodic record (scene summaries');
    expect(verifyPrompt).toContain(sceneGist);
    delete process.env.RETRIEVAL_SCENE_LANE;
  });

  it('FENCE — a CROSS-USER caller gets NO scene line and cannot cite the scene', async () => {
    process.env.RETRIEVAL_SCENE_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: `The flat lease was signed [${factId}].`,
        citedFactIds: [factId],
        // Even a probing generator cannot surface another user's scene:
        // the id is not in the rendered set, so it is dropped.
        citedSceneIds: [sceneId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: OTHER_USER });
    expect(res.status).toBe(201);
    expect(res.body.evidenceCitations).toBeUndefined();
    expect(state.calls[0]!.user).not.toContain('Episodic record');
    expect(state.calls[0]!.user).not.toContain(sceneId);
    delete process.env.RETRIEVAL_SCENE_LANE;
  });

  it('FENCE — an UNSCOPED caller gets NO scene line (scoped-user-only)', async () => {
    process.env.RETRIEVAL_SCENE_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: `The flat lease was signed [${factId}].`,
        citedFactIds: [factId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY });
    expect(res.status).toBe(201);
    expect(state.calls[0]!.user).not.toContain('Episodic record');
    expect(state.calls[0]!.user).not.toContain('[memory_episode:');
    delete process.env.RETRIEVAL_SCENE_LANE;
  });

  it('an UNPROMOTED world does not serve — demote the registry row and the lane goes empty', async () => {
    process.env.RETRIEVAL_SCENE_LANE = '1';
    await db(async (d) => {
      await d.query(`UPDATE projection SET status = 'built' WHERE name = 'scenes'`);
    });
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: `The flat lease was signed [${factId}].`,
        citedFactIds: [factId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: USER });
    expect(res.status).toBe(201);
    expect(state.calls[0]!.user).not.toContain('Episodic record');
    expect(res.body.evidenceCitations).toBeUndefined();
    delete process.env.RETRIEVAL_SCENE_LANE;
  });
});
