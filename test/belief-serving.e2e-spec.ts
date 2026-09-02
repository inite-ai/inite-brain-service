/**
 * Belief serving lane e2e (BELIEFS_SERVING_LANE) over a real SurrealDB
 * (testcontainer) — the dogfood acceptance scenario the lane exists for:
 * the user decided Postgres, then SWITCHED to SurrealDB; free extraction
 * produced non-colliding claims (both alive — the supersede never
 * fired), while the belief substrate holds the CORRECT current state.
 *
 * Substrate: the EXACT dogfood shape — two alive facts
 * (`PostgreSQL|code_memory__decided|we will use Postgres as the main
 * database` + `SurrealDB|interacted_with|SurrealDB`) and one enriched
 * scene with stateDelta {subject:'inventory service', field:'database',
 * from:'PostgreSQL', to:'SurrealDB'} for USER, folded by the Belief-A
 * promotion into an active belief value=SurrealDB.
 *
 * Pins:
 *   1. CONTROL (flag off): the generator prompt carries NO belief
 *      section and the response no evidenceCitations — today's stale
 *      serving, byte-identical with the substrate fully populated;
 *   2. flag ON: the belief line renders for generator AND verifier
 *      (evidence parity), the scripted generator cites the belief id ⇒
 *      the served answer says SurrealDB with a belief-arm evidence
 *      citation whose excerpt IS the rendered statement, and 0107
 *      memory_outcome rows land under subjectKind='belief'
 *      (selected_for_context + used_in_answer + verifier_supported);
 *   3. history non-regression (flag on): the fact lines stay in the
 *      prompt and the scripted answer covers the PostgreSQL→SurrealDB
 *      transition — the in-prompt routing never removes fact evidence;
 *   4. user fence (D4): another user gets NO belief line; an unscoped
 *      request gets NO belief line (stricter than the read API).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

const USER = 'dogfood_u1';
const OTHER_USER = 'dogfood_u2';
const QUERY = 'which database are we using for the inventory service?';
const HISTORY_QUERY = 'how did the database choice for the inventory service change?';
const STATEMENT = 'inventory service — database: SurrealDB (was: PostgreSQL)';
const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });

const FLAG_KEYS = ['BELIEFS_SERVING_LANE', 'OUTCOME_TELEMETRY_ENABLED'] as const;

describe('Belief serving lane e2e (the dogfood stale-answer scenario)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  let pgFactId: string;
  let beliefId: string;

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  /** Outcome writers are fire-and-forget — poll until the rows land. */
  const waitFor = async <T>(probe: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    for (let i = 0; i < 40; i++) {
      const v = await probe();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return probe();
  };

  beforeAll(async () => {
    for (const k of [
      ...FLAG_KEYS,
      'RETRIEVAL_ABSTENTION_CALIBRATION',
      'SCENES_SEGMENTATION_ENABLED',
      'SCENES_BELIEF_PROMOTION',
    ]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Pin abstention off so a thin-evidence query never pre-abstains
    // before generation (the 0113 e2e discipline).
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    f = await createApp({ companyId: 'co_belief_serving_e2e' });

    // The dogfood fact pair — non-colliding (entity, predicate) keys, so
    // fn::resolve_fact never superseded either; BOTH stay alive.
    // Tenant-global (no userId) so every fence variant below still has
    // fact evidence to synthesize from.
    const pg = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'proj', id: 'postgresql' },
        predicate: 'code_memory__decided',
        object: 'we will use Postgres as the main database',
        validFrom: new Date('2026-08-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'proj', recorder: 'bot' },
      });
    expect([200, 201]).toContain(pg.status);
    pgFactId = pg.body.factId as string;
    expect(pgFactId).toBeTruthy();
    const sdb = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'proj', id: 'surrealdb' },
        predicate: 'interacted_with',
        object: 'SurrealDB is the database now used by the inventory service',
        validFrom: new Date('2026-08-10').toISOString(),
        confidence: 0.9,
        source: { vertical: 'proj', recorder: 'bot' },
      });
    expect([200, 201]).toContain(sdb.status);

    // The enriched scene carrying the state delta (the belief-promotion
    // direct-seed precedent), then the Belief-A fold → active belief.
    await db(async (d) => {
      await d.query(
        `CREATE memory_episode:dogfood1 CONTENT {
           userId: $u, userIds: [$u], scope: [],
           sceneLabel: 'db switch', conversationIds: ['proj:c1'],
           occurredFrom: <datetime>'2026-08-10T10:00:00.000Z',
           occurredTo: <datetime>'2026-08-10T10:00:00.000Z',
           gist: 'switched the inventory service database',
           confidence: 1,
           stateDeltas: [{ subject: 'inventory service', field: 'database',
                           from: 'PostgreSQL', to: 'SurrealDB' }],
           segmenterVersion: 'scene-segmenter-v1', generation: 'seed-gen',
           source: { recorder: 'test-seed' },
           enrichmentVersion: 'seed-enrich-v1',
           enrichedMemoryValue: { explicitness: 0.8 } }`,
        { u: USER },
      );
    });
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_BELIEF_PROMOTION = '1';
    const promoted = await f.http.post('/v1/admin/maintenance/scenes/beliefs').set(auth()).send({});
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({ beliefsCreated: 1 });
    delete process.env.SCENES_SEGMENTATION_ENABLED;
    delete process.env.SCENES_BELIEF_PROMOTION;

    const beliefs = await db(async (d) => {
      const [rows] = await d.query<
        [Array<{ id: unknown; value: string; status: string; statement: string }>]
      >(`SELECT id, value, status, statement FROM semantic_belief`);
      return rows ?? [];
    });
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({ value: 'SurrealDB', status: 'active' });
    expect(beliefs[0]!.statement).toBe(STATEMENT);
    beliefId = String(beliefs[0]!.id);
  }, 120000);

  afterEach(() => {
    for (const k of FLAG_KEYS) delete process.env[k];
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('CONTROL — flag off: no belief section, no evidenceCitations, the stale path serves as today', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'We decided to use Postgres as the main database [' + pgFactId + '].',
        citedFactIds: [pgFactId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: USER });
    expect(res.status).toBe(201);
    expect(res.body.answer).toContain('Postgres');
    expect(res.body.evidenceCitations).toBeUndefined();
    expect(state.calls.length).toBe(2);
    // No belief section, no belief id, no citation affordance — the
    // substrate is fully populated yet serving is byte-identical.
    expect(state.calls[0]!.user).not.toContain('Current-state record');
    expect(state.calls[0]!.user).not.toContain('[semantic_belief:');
    expect(state.calls[0]!.system).not.toContain('BELIEF CITATIONS');
    expect(state.calls[0]!.system).not.toContain('BELIEF LINES PRESERVE ABSTENTION');
    expect(state.calls[1]!.user).not.toContain('Current-state record');
  });

  it('flag ON: belief line renders for generator AND verifier; cited belief ⇒ SurrealDB answer + belief-arm citation + 0107 rows', async () => {
    process.env.BELIEFS_SERVING_LANE = '1';
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer:
          'The inventory service now uses SurrealDB [' +
          beliefId +
          '] (previously Postgres [' +
          pgFactId +
          ']).',
        citedFactIds: [pgFactId],
        citedBeliefIds: [beliefId, 'semantic_belief:hallucinated'],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: USER });
    expect(res.status).toBe(201);
    expect(res.body.answer).toContain('SurrealDB');
    // The belief-arm evidence citation, through the rendered-set fence
    // (the hallucinated id dropped): excerpt IS the rendered statement.
    expect(res.body.evidenceCitations).toHaveLength(1);
    expect(res.body.evidenceCitations[0]).toMatchObject({
      beliefId,
      excerpt: STATEMENT,
    });
    // Generator saw the current-state section with the id header and
    // gained the schema affordance.
    const genPrompt = state.calls[0]!.user;
    expect(genPrompt).toContain('Current-state record');
    expect(genPrompt).toContain(`[${beliefId}]`);
    expect(genPrompt).toContain(STATEMENT);
    expect(state.calls[0]!.system).toContain('BELIEF CITATIONS');
    // Abstention discipline (memory-fitness D5): the rendered lane pulls in
    // the system-side guard mirroring the base abstention rule verbatim,
    // and the current-state preference is conditional on a covering line.
    expect(state.calls[0]!.system).toContain('BELIEF LINES PRESERVE ABSTENTION');
    expect(genPrompt).toContain('ONLY when one covers the asked subject/field');
    // Verifier parity (W5 #22): the SAME line arrives as its own section.
    const verifyPrompt = state.calls[1]!.user;
    expect(verifyPrompt).toContain('Current-state record (distilled belief lines');
    expect(verifyPrompt).toContain(STATEMENT);
    // 0107 telemetry: subjectKind='belief' rows for the rendered set
    // (selected_for_context) and the cited serve (used_in_answer +
    // verifier_supported under the scripted supported verdict).
    const events = await waitFor(
      () =>
        db(async (d) => {
          const [rows] = await d.query<[Array<{ event: string; subjectId: unknown }>]>(
            `SELECT event, subjectId FROM memory_outcome WHERE subjectKind = 'belief'`,
          );
          return rows ?? [];
        }),
      (rows) => rows.length >= 3,
    );
    const names = events.map((e) => e.event).sort();
    expect(names).toEqual(['selected_for_context', 'used_in_answer', 'verifier_supported']);
    for (const e of events) expect(String(e.subjectId)).toBe(beliefId);
  });

  it('history non-regression (flag ON): fact lines stay in the prompt; the scripted answer covers the transition', async () => {
    process.env.BELIEFS_SERVING_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer:
          'The team first decided on PostgreSQL, then switched the inventory service to ' +
          'SurrealDB [' +
          pgFactId +
          '].',
        citedFactIds: [pgFactId],
        citedBeliefIds: [],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: HISTORY_QUERY, userId: USER });
    expect(res.status).toBe(201);
    // The answer covers the PostgreSQL→SurrealDB transition.
    expect(res.body.answer).toContain('PostgreSQL');
    expect(res.body.answer).toContain('SurrealDB');
    const genPrompt = state.calls[0]!.user;
    // The fact record (the update story's raw material) is still there —
    // the belief section ROUTES in-prompt, it never displaces evidence.
    expect(genPrompt).toContain('Retrieved facts:');
    expect(genPrompt).toContain('we will use Postgres as the main database');
    // The belief section is present and its header routes history
    // questions to facts + transcript.
    expect(genPrompt).toContain('Current-state record');
    expect(genPrompt).toContain('For questions about history');
  });

  it('user fence (D4): OTHER_USER gets no belief line; an unscoped request gets no belief line', async () => {
    process.env.BELIEFS_SERVING_LANE = '1';
    const otherState = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'Postgres [' + pgFactId + '].', citedFactIds: [pgFactId] }),
      VERIFY_SUPPORTED,
    ]);
    const other = await synth({ query: QUERY, userId: OTHER_USER });
    expect(other.status).toBe(201);
    expect(otherState.calls[0]!.user).not.toContain('Current-state record');
    expect(otherState.calls[0]!.user).not.toContain('[semantic_belief:');
    expect(other.body.evidenceCitations).toBeUndefined();

    const unscopedState = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'Postgres [' + pgFactId + '].', citedFactIds: [pgFactId] }),
      VERIFY_SUPPORTED,
    ]);
    const unscoped = await synth({ query: QUERY });
    expect(unscoped.status).toBe(201);
    expect(unscopedState.calls[0]!.user).not.toContain('Current-state record');
    expect(unscopedState.calls[0]!.user).not.toContain('[semantic_belief:');
    expect(unscoped.body.evidenceCitations).toBeUndefined();
  });
});
