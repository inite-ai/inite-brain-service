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

const USER = 'belief_u1';
const OTHER_USER = 'belief_u2';

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
           ${opts.enriched !== false ? `, enrichmentVersion: 'seed-enrich-v1', enrichedMemoryValue: { explicitness: 0.8 }` : ''}
         }`,
        {
          tail: opts.tail,
          conv: opts.conv,
          to: opts.occurredTo,
          deltas: opts.deltas,
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
    // the NEW revision; baselineRef names the revision the delta was
    // applied AGAINST.
    const sb = await sceneRow('sb');
    expect((sb.consolidatedInto ?? []).map(String)).toEqual([String(rev2!.id)]);
    expect(sb.baselineRef).toMatchObject({
      belief: String(rev1!.id),
      revision: 1,
      value: 'lisbon',
    });
    expect(sb.baselineRef!.stampedAt).toBeDefined();

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

  it('user-forget erases beliefs + their support edges unconditionally, with the beliefsDeleted counter', async () => {
    // Flag-independence: rows written while on must die while OFF.
    delete process.env.SCENES_BELIEF_PROMOTION;
    delete process.env.PROVENANCE_SUPPORT_EDGES;

    const before = await beliefs();
    expect(before.length).toBe(3); // home.city rev1+rev2 + coffee.pref
    const res = await f.http.post(`/v1/users/${USER}/forget`).set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body.beliefsDeleted).toBe(3);

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
});
