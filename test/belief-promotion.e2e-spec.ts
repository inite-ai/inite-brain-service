/**
 * Belief-A e2e on real SurrealDB: promotion fold (POST
 * /v1/admin/maintenance/scenes/beliefs), the SCENES_BELIEF_MIN_SCENES
 * distinct-conversation floor, the built-in conflict guard, the #387
 * mixed-user/legacy fail-closed skip, supersede-chain revisions (never
 * in-place for values), consolidatedInto/baselineRef stamps on consumed
 * scenes, the PROVENANCE_SUPPORT_EDGES mirror (supported_by /
 * contradicted_by / derived_from, writer belief_promotion), optional
 * LLM statement synthesis (stubbed — no paid calls), and the GDPR
 * cascade through BOTH forget services with the beliefsDeleted counter.
 *
 * Scene rows are seeded directly in the DB (the facts-list-competing
 * direct-seed precedent): the composer/enricher have their own suites,
 * and hand-seeded rows make the fold deterministic — the promotion
 * consumes enriched columns regardless of who wrote them.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockBeliefSynthesisOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import { beliefIdTail } from '../src/admin/belief-promotion.service';
import { readSceneBaselineRef } from '../src/admin/scene-baseline-ref';

const USER = 'belief_u1';
const OTHER_USER = 'belief_u2';
/** Own user for the value-gate leg — untouched by the GDPR cascades above. */
const GATE_USER = 'belief_u3';
/** Own user for the two-producer baselineRef leg. */
const BASELINE_USER = 'belief_u4';

interface BeliefRow {
  id: unknown;
  userId: string;
  subject: string;
  field: string;
  value: string;
  priorValue?: string;
  statement: string;
  statementSource: string;
  confidence: number;
  revision: number;
  status: string;
  supersededBy?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  sourceSceneIds?: unknown[];
  conversationIds?: string[];
  corroborationCount?: number;
  conversationCount?: number;
  promoterVersion?: string;
}

describe('belief promotion + GDPR cascade (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  const FLAGS = [
    'SCENES_SEGMENTATION_ENABLED',
    'SCENES_BELIEF_PROMOTION',
    'SCENES_BELIEF_MIN_SCENES',
    'SCENES_BELIEF_LLM_SYNTHESIS',
    'SCENES_BELIEF_NEGATION_DELTAS',
    'SCENES_BELIEF_FIELD_FOLD',
    'SCENES_VALUE_GATE_ENABLED',
    'SCENES_VALUE_GATE_MIN',
    'PROVENANCE_SUPPORT_EDGES',
  ];

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const seedScene = async (opts: {
    tail: string;
    conv: string;
    user?: string;
    users?: string[];
    occurredTo: string;
    deltas: Array<{ subject: string; field: string; from: string; to: string }>;
    enriched?: boolean;
    /**
     * enrichedMemoryValue override. Defaults to the historical
     * explicitness-only vector, so every pre-existing fixture keeps
     * exactly the row it had — the value gate reads the three extra
     * dimensions as UNDEFINED there, which promotes.
     */
    value?: Record<string, number>;
  }): Promise<void> => {
    await db(async (d) => {
      await d.query(
        `CREATE type::record('memory_episode', $tail) CONTENT {
           ${opts.user !== undefined ? 'userId: $user,' : ''}
           ${opts.users !== undefined ? 'userIds: $users,' : ''}
           scope: [],
           sceneLabel: 'seed',
           conversationIds: [$conv],
           occurredFrom: <datetime>$to,
           occurredTo: <datetime>$to,
           gist: 'seed gist',
           confidence: 1,
           stateDeltas: $deltas,
           segmenterVersion: 'scene-segmenter-v1',
           generation: 'seed-gen',
           source: { recorder: 'test-seed' }
           ${opts.enriched !== false ? `, enrichmentVersion: 'seed-enrich-v1', enrichedMemoryValue: $value` : ''}
         }`,
        {
          tail: opts.tail,
          conv: opts.conv,
          to: opts.occurredTo,
          deltas: opts.deltas,
          value: opts.value ?? { explicitness: 0.8 },
          ...(opts.user !== undefined ? { user: opts.user } : {}),
          ...(opts.users !== undefined ? { users: opts.users } : {}),
        },
      );
    });
  };

  const beliefs = (): Promise<BeliefRow[]> =>
    db(async (d) => {
      const [rows] = await d.query<[BeliefRow[]]>(
        `SELECT * FROM semantic_belief ORDER BY subject ASC, field ASC, revision ASC`,
      );
      return rows ?? [];
    });

  const supportRows = (): Promise<
    Array<{ in: unknown; out: unknown; kind: string; writer: string }>
  > =>
    db(async (d) => {
      const [rows] = await d.query<
        [Array<{ in: unknown; out: unknown; kind: string; writer: string }>]
      >(`SELECT in, out, kind, writer FROM memory_support ORDER BY kind ASC`);
      return rows ?? [];
    });

  const sceneRow = (
    tail: string,
  ): Promise<{ consolidatedInto?: unknown[]; baselineRef?: Record<string, unknown> }> =>
    db(async (d) => {
      const [rows] = await d.query<
        [Array<{ consolidatedInto?: unknown[]; baselineRef?: Record<string, unknown> }>]
      >(`SELECT consolidatedInto, baselineRef FROM type::record('memory_episode', $tail)`, {
        tail,
      });
      return (rows ?? [])[0] ?? {};
    });

  const promote = () => f.http.post('/v1/admin/maintenance/scenes/beliefs').set(auth()).send({});

  /** Conversation-scoped promotion — exact counters regardless of what
   *  the earlier fixtures (and the GDPR cascades) left behind. */
  const promoteConv = (conversationId: string) =>
    f.http.post('/v1/admin/maintenance/scenes/beliefs').set(auth()).send({ conversationId });

  beforeAll(async () => {
    for (const k of FLAGS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    f = await createApp({ companyId: 'co_belief_e2e' });

    // Corroborating pair (distinct conversations) + a single-conversation
    // key (the floor probe) + the skip fixtures.
    await seedScene({
      tail: 'sa1',
      conv: 'proj:c1',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-01T10:00:00.000Z',
      deltas: [
        { subject: 'mika', field: 'home.city', from: '', to: 'lisbon' },
        { subject: 'mika', field: 'coffee.pref', from: '', to: 'espresso' },
      ],
    });
    await seedScene({
      tail: 'sa2',
      conv: 'proj:c2',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-02T10:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'home.city', from: '', to: 'lisbon' }],
    });
    // Mixed-user group (#387: skip fail-closed, loudly).
    await seedScene({
      tail: 'smixed',
      conv: 'proj:c1',
      users: [USER, OTHER_USER],
      occurredTo: '2026-03-01T11:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'pet', from: '', to: 'cat' }],
    });
    // Legacy pre-0117 row: userId stamped, userIds NEVER written.
    await seedScene({
      tail: 'slegacy',
      conv: 'proj:c1',
      user: USER,
      occurredTo: '2026-03-01T11:30:00.000Z',
      deltas: [{ subject: 'mika', field: 'pet', from: '', to: 'cat' }],
    });
    // Irreconcilable in-batch value group: same timestamp, two values.
    await seedScene({
      tail: 'sconfa',
      conv: 'proj:c1',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-01T12:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'job.title', from: '', to: 'engineer' }],
    });
    await seedScene({
      tail: 'sconfb',
      conv: 'proj:c2',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-01T12:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'job.title', from: '', to: 'designer' }],
    });
    // Un-enriched control: never consumed (enrichmentVersion is NONE).
    await seedScene({
      tail: 'splain',
      conv: 'proj:c1',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-01T13:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'drink', from: '', to: 'tea' }],
      enriched: false,
    });
  }, 120000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('404-gates both ways and writes NOTHING while off (byte-identical prod)', async () => {
    // Master on, belief flag off.
    expect((await promote()).status).toBe(404);
    // Master off, belief flag on.
    process.env.SCENES_BELIEF_PROMOTION = '1';
    delete process.env.SCENES_SEGMENTATION_ENABLED;
    expect((await promote()).status).toBe(404);
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    delete process.env.SCENES_BELIEF_PROMOTION;
    expect(await beliefs()).toEqual([]);
  });

  it('promotes with the distinct-conversation floor: corroborated key in, single-conversation key out', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    process.env.SCENES_BELIEF_MIN_SCENES = '2';
    const res = await promote();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      scenes: 6, // enriched scenes only — splain is invisible
      eligibleScenes: 4,
      skippedMixedUser: 2, // smixed (mixed group) + slegacy (no userIds)
      skippedConflict: 1, // job.title: engineer vs designer, same instant
      skippedFloor: 1, // coffee.pref: 1 conversation < floor 2
      beliefsCreated: 1, // home.city
      beliefsCorroborated: 0,
      beliefsRevised: 0,
      supportEdges: 0, // PROVENANCE_SUPPORT_EDGES off
    });

    const rows = await beliefs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER,
      subject: 'mika',
      field: 'home.city',
      value: 'lisbon',
      statement: 'mika — home.city: lisbon',
      statementSource: 'template',
      confidence: 0.85, // mean explicitness 0.8 + 0.05 corroboration bonus
      revision: 1,
      status: 'active',
      conversationIds: ['proj:c1', 'proj:c2'],
      corroborationCount: 2,
      conversationCount: 2,
      promoterVersion: 'belief-promotion-v1|scene-segmenter-v1',
    });
    expect(String(rows[0]!.id)).toContain(
      beliefIdTail({ userId: USER, subject: 'mika', field: 'home.city' }, 1),
    );
    expect((rows[0]!.sourceSceneIds ?? []).map(String).sort()).toEqual([
      'memory_episode:sa1',
      'memory_episode:sa2',
    ]);

    // Consumed scenes carry the consolidatedInto stamp; revision 1 has
    // NO baseline. Skipped groups' scenes stay untouched.
    const beliefId = String(rows[0]!.id);
    for (const tail of ['sa1', 'sa2']) {
      const s = await sceneRow(tail);
      expect((s.consolidatedInto ?? []).map(String)).toEqual([beliefId]);
      expect(s.baselineRef).toBeUndefined();
    }
    for (const tail of ['smixed', 'slegacy', 'sconfa', 'sconfb', 'splain']) {
      expect((await sceneRow(tail)).consolidatedInto).toBeUndefined();
    }
    expect(await supportRows()).toEqual([]);
  });

  it('floor off: the single-conversation key promotes (LLM-synthesized statement, stubbed), re-fold is idempotent, edges mirror', async () => {
    delete process.env.SCENES_BELIEF_MIN_SCENES;
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    process.env.SCENES_BELIEF_LLM_SYNTHESIS = '1';
    const mock = mockBeliefSynthesisOpenAi(f.app, [
      JSON.stringify({ statement: 'Mika prefers espresso.' }),
    ]);

    const res = await promote();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      skippedMixedUser: 2,
      skippedConflict: 1,
      skippedFloor: 0,
      beliefsCreated: 1, // coffee.pref
      beliefsCorroborated: 0, // home.city: same value, zero NEW scenes
      beliefsRevised: 0,
      supportEdges: 3, // supported_by: coffee->sa1 + home.city->{sa1,sa2}
    });
    // ONE call — only the coffee.pref CREATE synthesizes; the home.city
    // no-op corroboration never calls the model.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.user).toContain('coffee.pref');

    const rows = await beliefs();
    expect(rows).toHaveLength(2);
    const coffee = rows.find((r) => r.field === 'coffee.pref')!;
    expect(coffee).toMatchObject({
      value: 'espresso',
      statement: 'Mika prefers espresso.',
      statementSource: 'llm',
      revision: 1,
      status: 'active',
      corroborationCount: 1,
      conversationCount: 1,
    });

    const edges = await supportRows();
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e.kind).toBe('supported_by');
      expect(e.writer).toBe('belief_promotion');
      expect(String(e.in)).toContain('semantic_belief:');
      expect(String(e.out)).toContain('memory_episode:');
    }
  });

  it('revises on a new value: supersede chain, baselineRef, contradiction edges — never in-place', async () => {
    delete process.env.SCENES_BELIEF_LLM_SYNTHESIS;
    await seedScene({
      tail: 'sb',
      conv: 'proj:c3',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-05T10:00:00.000Z',
      deltas: [{ subject: 'mika', field: 'home.city', from: 'lisbon', to: 'porto' }],
    });

    const res = await promote();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ beliefsCreated: 0, beliefsRevised: 1 });

    const rows = await beliefs();
    const chain = rows.filter((r) => r.field === 'home.city');
    expect(chain).toHaveLength(2);
    const [rev1, rev2] = chain;
    expect(rev1).toMatchObject({ revision: 1, value: 'lisbon', status: 'superseded' });
    expect(String(rev1!.supersededBy)).toBe(String(rev2!.id));
    expect(rev1!.validUntil).toBeDefined();
    expect(rev2).toMatchObject({
      revision: 2,
      value: 'porto',
      priorValue: 'lisbon', // the ACTUAL displaced value
      statement: 'mika — home.city: porto (was: lisbon)',
      statementSource: 'template',
      status: 'active',
    });
    expect((rev2!.sourceSceneIds ?? []).map(String)).toEqual(['memory_episode:sb']);

    // The 0106 contracts on the consumed scene: consolidatedInto names
    // the NEW revision; the NAMESPACED baselineRef.supersededFrom names
    // the revision the delta was applied AGAINST (the sibling
    // `expectation` section belongs to the enrichment pass — see the
    // coexistence test below).
    const sb = await sceneRow('sb');
    expect((sb.consolidatedInto ?? []).map(String)).toEqual([String(rev2!.id)]);
    expect(sb.baselineRef).toMatchObject({
      supersededFrom: { belief: String(rev1!.id), revision: 1, value: 'lisbon' },
    });
    expect(readSceneBaselineRef(sb.baselineRef).supersededFrom!.stampedAt).not.toBe('');
    expect(Object.keys(sb.baselineRef!)).toEqual(['supersededFrom']);

    const edges = await supportRows();
    const contradiction = edges.filter((e) => e.kind === 'contradicted_by');
    const derivation = edges.filter((e) => e.kind === 'derived_from');
    expect(contradiction).toHaveLength(1);
    expect(String(contradiction[0]!.in)).toBe(String(rev1!.id)); // old ->
    expect(String(contradiction[0]!.out)).toBe(String(rev2!.id)); // -> new
    expect(derivation).toHaveLength(1);
    expect(String(derivation[0]!.in)).toBe(String(rev2!.id)); // new ->
    expect(String(derivation[0]!.out)).toBe(String(rev1!.id)); // -> old

    // Idempotent re-fold: the winning value now matches revision 2 —
    // nothing new is created and the chain stays two rows.
    const rerun = await promote();
    expect(rerun.status).toBe(201);
    expect(rerun.body).toMatchObject({
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
    });
    expect((await beliefs()).filter((r) => r.field === 'home.city')).toHaveLength(2);
  });

  it('negation + field fold (#135): an empty-`to` delta under a re-coined field name revises to the sentinel', async () => {
    process.env.SCENES_BELIEF_NEGATION_DELTAS = '1';
    process.env.SCENES_BELIEF_FIELD_FOLD = '1';

    // The live Compass shape, scene 1: acquisition — belief created.
    await seedScene({
      tail: 'scar1',
      conv: 'proj:c4',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-06T10:00:00.000Z',
      deltas: [{ subject: 'Mikhail', field: 'car', from: '', to: 'Jeep Compass' }],
    });
    const first = await promote();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ beliefsCreated: 1, beliefsRevised: 0, fieldFolds: 0 });

    // Scene 2: state REMOVAL under a RE-COINED field name — historically
    // this delta vanished at the no-landing-value guard AND would have
    // keyed a fresh parallel group ('car ownership' ≠ 'car').
    await seedScene({
      tail: 'scar2',
      conv: 'proj:c5',
      user: USER,
      users: [USER],
      occurredTo: '2026-03-07T10:00:00.000Z',
      deltas: [{ subject: 'Mikhail', field: 'car ownership', from: 'Compass', to: '' }],
    });
    const second = await promote();
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      beliefsCreated: 0,
      beliefsRevised: 1,
      fieldFolds: 1,
      fieldFoldAmbiguous: 0,
    });

    const chain = (await beliefs()).filter((r) => r.subject === 'Mikhail' && r.field === 'car');
    expect(chain).toHaveLength(2);
    const [rev1, rev2] = chain;
    expect(rev1).toMatchObject({ revision: 1, value: 'Jeep Compass', status: 'superseded' });
    expect(String(rev1!.supersededBy)).toBe(String(rev2!.id));
    expect(rev2).toMatchObject({
      revision: 2,
      value: 'none',
      priorValue: 'Jeep Compass', // the ACTUAL displaced value beats the delta's 'Compass'
      statement: 'Mikhail — car: none (was: Jeep Compass)',
      statementSource: 'template',
      status: 'active',
    });
    // NO parallel 'car ownership' belief exists — the fold won.
    expect((await beliefs()).filter((r) => r.field === 'car ownership')).toEqual([]);

    // The full revision contract fires for the negation delta too.
    const scar2 = await sceneRow('scar2');
    expect((scar2.consolidatedInto ?? []).map(String)).toEqual([String(rev2!.id)]);
    expect(scar2.baselineRef).toMatchObject({
      supersededFrom: { belief: String(rev1!.id), revision: 1, value: 'Jeep Compass' },
    });

    delete process.env.SCENES_BELIEF_NEGATION_DELTAS;
    delete process.env.SCENES_BELIEF_FIELD_FOLD;
  });

  it('user-forget erases beliefs + their support edges unconditionally, with the beliefsDeleted counter', async () => {
    // Flag-independence: rows written while on must die while OFF.
    delete process.env.SCENES_BELIEF_PROMOTION;
    delete process.env.PROVENANCE_SUPPORT_EDGES;

    const before = await beliefs();
    // home.city rev1+rev2 + coffee.pref + car rev1+rev2 (#135 fixture)
    expect(before.length).toBe(5);
    const res = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body.beliefsDeleted).toBe(5);

    expect(await beliefs()).toEqual([]);
    expect(await supportRows()).toEqual([]);
  });

  it('entity-forget cascades scene-mediated beliefs (dying episode -> scene -> belief) with the counter', async () => {
    // Minimal grounding graph: entity -> fact (grounded in one episode)
    // -> scene membership -> a belief sourced from that scene, plus its
    // support edge — all seeded directly (the promotion path was proven
    // above; this leg proves the erase linkage).
    await db(async (d) => {
      await d.query(
        `CREATE knowledge_entity:bf_subj CONTENT {
           type: 'other', canonicalName: 'BeliefSubject', externalRefs: { proj: 'bf_subj' } }`,
      );
      await d.query(
        `CREATE episode:bf_ep CONTENT {
           kind: 'turn', messageId: 'bf_m1', text: 'belief grounding turn',
           occurredAt: <datetime>'2026-03-01T09:00:00.000Z', userId: $u,
           conversationId: 'proj:c9', source: { vertical: 'proj' } }`,
        { u: OTHER_USER },
      );
      await d.query(
        `CREATE knowledge_fact:bf_fact CONTENT {
           entityId: knowledge_entity:bf_subj, predicate: 'note',
           object: 'grounded note', confidence: 0.9,
           validFrom: <datetime>'2026-03-01T09:00:00.000Z',
           source: { vertical: 'derived', recorder: 'test-seed',
                     conversationId: 'proj:c9', episodeIds: ['episode:bf_ep'] } }`,
      );
      await d.query(
        `CREATE memory_episode:bf_scene CONTENT {
           userId: $u, userIds: [$u], scope: [], sceneLabel: 'seed',
           conversationIds: ['proj:c9'],
           occurredFrom: <datetime>'2026-03-01T09:00:00.000Z',
           occurredTo: <datetime>'2026-03-01T09:00:00.000Z',
           gist: 'seed gist', confidence: 1,
           segmenterVersion: 'scene-segmenter-v1', generation: 'seed-gen',
           source: { recorder: 'test-seed' } }`,
        { u: OTHER_USER },
      );
      await d.query(
        `INSERT RELATION INTO memory_episode_member {
           in: memory_episode:bf_scene, out: episode:bf_ep,
           role: 'core', ord: 0, relevance: 1,
           segmenterVersion: 'scene-segmenter-v1' }`,
      );
      await d.query(
        `CREATE semantic_belief:bf_belief CONTENT {
           userId: $u, subject: 'other', field: 'pet', value: 'dog',
           statement: 'other — pet: dog', statementSource: 'template',
           confidence: 0.8, revision: 1, status: 'active',
           validFrom: <datetime>'2026-03-01T09:00:00.000Z',
           sourceSceneIds: [memory_episode:bf_scene],
           conversationIds: ['proj:c9'], corroborationCount: 1,
           conversationCount: 1,
           promoterVersion: 'belief-promotion-v1|scene-segmenter-v1' }`,
        { u: OTHER_USER },
      );
      await d.query(
        `INSERT RELATION INTO memory_support {
           in: semantic_belief:bf_belief, out: memory_episode:bf_scene,
           kind: 'supported_by', writer: 'belief_promotion' }`,
      );
    });

    const res = await f.http
      .post('/v1/entities/knowledge_entity:bf_subj/forget')
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'belief-forget-1' });
    expect(res.status).toBe(201);
    expect(res.body.beliefsDeleted).toBe(1);

    expect(await beliefs()).toEqual([]);
    expect(await supportRows()).toEqual([]);
    const tomb = await db(async (d) => {
      const [rows] = await d.query<[Array<{ beliefsDeleted?: number }>]>(
        `SELECT beliefsDeleted FROM forgotten_entity WHERE requestId = 'belief-forget-1'`,
      );
      return (rows ?? [])[0];
    });
    expect(tomb?.beliefsDeleted).toBe(1);

    // Idempotent replay carries the stored counter.
    const replay = await f.http
      .post('/v1/entities/knowledge_entity:bf_subj/forget')
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'belief-forget-1' });
    expect(replay.status).toBe(201);
    expect(replay.body.beliefsDeleted).toBe(1);
  });

  it('memory-value gate: the noisy scene is skipped with it ON and promoted with it OFF', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    delete process.env.SCENES_BELIEF_MIN_SCENES;
    const CONV = 'proj:gate';

    // Two scenes, one conversation. The first is what the gate exists
    // for: every producer scored it at essentially zero. The second is
    // the case the gate must never touch — nothing new, nothing durable,
    // but it DISAGREES with the world model, which is exactly the kind
    // of scene whose deltas most deserve promotion.
    await seedScene({
      tail: 'sgate_noise',
      conv: CONV,
      user: GATE_USER,
      users: [GATE_USER],
      occurredTo: '2026-04-01T10:00:00.000Z',
      deltas: [{ subject: 'gata', field: 'snack', from: '', to: 'crisps' }],
      value: { explicitness: 0.8, novelty: 0.01, contradiction: 0, stateChange: 0 },
    });
    await seedScene({
      tail: 'sgate_signal',
      conv: CONV,
      user: GATE_USER,
      users: [GATE_USER],
      occurredTo: '2026-04-01T11:00:00.000Z',
      deltas: [{ subject: 'gata', field: 'home.city', from: '', to: 'porto' }],
      value: { explicitness: 0.8, novelty: 0, contradiction: 0.9, stateChange: 0 },
    });

    const mine = async (): Promise<BeliefRow[]> =>
      (await beliefs()).filter((r) => r.userId === GATE_USER);

    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const gated = await promoteConv(CONV);
    expect(gated.status).toBe(201);
    expect(gated.body).toMatchObject({
      scenes: 2,
      eligibleScenes: 1, // the noisy scene never reaches the fold
      skippedLowValue: 1,
      skippedMixedUser: 0,
      beliefsCreated: 1,
    });
    expect((await mine()).map((r) => r.field)).toEqual(['home.city']);

    // Flag off: the SAME world promotes the SAME noisy scene it refused.
    delete process.env.SCENES_VALUE_GATE_ENABLED;
    const ungated = await promoteConv(CONV);
    expect(ungated.status).toBe(201);
    expect(ungated.body).toMatchObject({
      scenes: 2,
      eligibleScenes: 2,
      skippedLowValue: 0,
      beliefsCreated: 1, // snack; home.city is an unchanged no-op
      beliefsRevised: 0,
    });
    expect((await mine()).map((r) => r.field).sort()).toEqual(['home.city', 'snack']);
  });

  it('baselineRef: the enricher’s expectation and the promoter’s backpointer coexist on one scene', async () => {
    process.env.SCENES_BELIEF_PROMOTION = '1';
    delete process.env.SCENES_VALUE_GATE_ENABLED;
    const CONV = 'proj:baseline';

    await seedScene({
      tail: 'sbase1',
      conv: CONV,
      user: BASELINE_USER,
      users: [BASELINE_USER],
      occurredTo: '2026-05-01T10:00:00.000Z',
      deltas: [{ subject: 'bruno', field: 'home.city', from: '', to: 'lisbon' }],
    });
    const first = await promoteConv(CONV);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ beliefsCreated: 1 });
    const rev1 = (await beliefs()).find((r) => r.userId === BASELINE_USER)!;

    // The SECOND scene carries the revising value AND — as the enrichment
    // pass under SCENES_PREDICTION_BASELINE would have left it — a
    // legacy-A expectation snapshot already sitting in `baselineRef`.
    await seedScene({
      tail: 'sbase2',
      conv: CONV,
      user: BASELINE_USER,
      users: [BASELINE_USER],
      occurredTo: '2026-05-02T10:00:00.000Z',
      deltas: [{ subject: 'bruno', field: 'home.city', from: 'lisbon', to: 'porto' }],
    });
    await db(async (d) => {
      await d.query(`UPDATE memory_episode:sbase2 SET baselineRef = $ref`, {
        ref: {
          beliefs: [
            {
              id: String(rev1.id),
              subject: 'bruno',
              field: 'home.city',
              value: 'lisbon',
              revision: 1,
            },
          ],
          stampedAt: '2026-05-02T09:59:00.000Z',
          baselineVersion: 'scene-baseline-v1',
        },
      });
    });

    const second = await promoteConv(CONV);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ beliefsRevised: 1 });

    // BOTH sections are on the row, under their own keys — the promotion
    // no longer eats the pre-scene world model.
    const scene = await sceneRow('sbase2');
    expect(Object.keys(scene.baselineRef!).sort()).toEqual(['expectation', 'supersededFrom']);
    const sections = readSceneBaselineRef(scene.baselineRef);
    expect(sections.expectation).toMatchObject({
      baselineVersion: 'scene-baseline-v1',
      stampedAt: '2026-05-02T09:59:00.000Z',
    });
    expect(sections.expectation!.beliefs).toHaveLength(1);
    expect(sections.supersededFrom).toMatchObject({
      belief: String(rev1.id),
      revision: 1,
      value: 'lisbon',
    });

    // And the belief chain itself is the ordinary supersede chain.
    const chain = (await beliefs()).filter((r) => r.userId === BASELINE_USER);
    expect(chain.map((r) => `${r.revision}:${r.value}:${r.status}`)).toEqual([
      '1:lisbon:superseded',
      '2:porto:active',
    ]);
  });
});
