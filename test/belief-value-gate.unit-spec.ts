/**
 * The memory-value promotion gate (SCENES_VALUE_GATE_ENABLED) — the
 * first real consumer of the 0106 scene value vector.
 *
 * The whole point of this suite is the ASYMMETRY: "promote unless
 * demonstrably noise". A scene is refused only when all three gated
 * dimensions are present and all three are below the floor; anything
 * else — one high dimension, one MISSING dimension, no vector at all —
 * promotes. The undefined-is-not-zero row is pinned explicitly, because
 * reading silence as a confident 0 would undo the write-side rule
 * scene-scorer-v1 was built around.
 */
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import {
  VALUE_GATE_DIMS,
  formatValueDims,
  readSceneValueVector,
  sceneValueVerdict,
} from '../src/admin/belief-value-gate';
import { buildPromotableScenesQuery } from '../src/admin/belief-scene-selection';
import {
  BeliefPromotionService,
  type PromotableSceneHead,
} from '../src/admin/belief-promotion.service';
import { sceneValueGateEnabled, sceneValueGateMin } from '../src/common/scene-flags';

const MIN = 0.05;

describe('sceneValueVerdict (the gate policy)', () => {
  it('gates exactly three dimensions, in a stable order', () => {
    expect(VALUE_GATE_DIMS).toEqual(['novelty', 'contradiction', 'stateChange']);
  });

  it('HIGH contradiction promotes — the scene that changes the world model', () => {
    // The motivating case: nothing new, nothing durable, but the scene
    // DISAGREES with what the system already believes. Its deltas are
    // the ones that most deserve to reach the belief plane.
    const verdict = sceneValueVerdict({ novelty: 0, contradiction: 0.9, stateChange: 0 }, MIN);
    expect(verdict).toMatchObject({ promote: true, reason: 'above-floor' });
  });

  it.each([
    ['novelty alone', { novelty: 0.4, contradiction: 0, stateChange: 0 }],
    ['stateChange alone', { novelty: 0, contradiction: 0, stateChange: 0.4 }],
    ['exactly at the floor', { novelty: MIN, contradiction: 0, stateChange: 0 }],
  ])('one dimension above the floor is enough: %s', (_name, dims) => {
    expect(sceneValueVerdict(dims, MIN).promote).toBe(true);
  });

  it('ALL THREE below the floor is the one verdict that refuses', () => {
    const verdict = sceneValueVerdict({ novelty: 0.01, contradiction: 0, stateChange: 0.049 }, MIN);
    expect(verdict).toEqual({
      promote: false,
      reason: 'below-floor',
      dims: { novelty: 0.01, contradiction: 0, stateChange: 0.049 },
    });
  });

  // UNDEFINED IS NOT ZERO — the read-side half of the #473 write-side
  // rule. Each row would be REFUSED if the missing dimension were read
  // as 0; every one of them must promote instead.
  it.each([
    ['contradiction unmeasured (no matching belief)', { novelty: 0, stateChange: 0 }],
    ['novelty unmeasured (no embeddings at compose)', { contradiction: 0, stateChange: 0 }],
    ['stateChange unmeasured (no deltas scored)', { novelty: 0, contradiction: 0 }],
    ['nothing measured at all (pack / legacy scene)', {}],
    [
      'a NON-numeric dimension is not a measurement',
      { novelty: '0', contradiction: 0, stateChange: 0 },
    ],
    ['NaN is not a measurement', { novelty: Number.NaN, contradiction: 0, stateChange: 0 }],
    ['null is not a measurement', { novelty: null, contradiction: 0, stateChange: 0 }],
  ])('undefined is NOT zero — %s promotes', (_name, scene) => {
    const verdict = sceneValueVerdict(scene, MIN);
    expect(verdict.promote).toBe(true);
    expect(verdict.reason).toBe('undetermined');
  });

  it('a floor of 0 makes the gate a no-op — every present dimension clears it', () => {
    expect(sceneValueVerdict({ novelty: 0, contradiction: 0, stateChange: 0 }, 0)).toMatchObject({
      promote: true,
      reason: 'above-floor',
    });
  });

  it('readSceneValueVector keeps finite numbers and drops everything else', () => {
    expect(
      readSceneValueVector({
        novelty: 0.5,
        contradiction: 'x',
        stateChange: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ novelty: 0.5 });
  });

  it('formatValueDims renders a stable, greppable fragment with ? for unknowns', () => {
    expect(formatValueDims({ novelty: 0.5, stateChange: 0 })).toBe(
      'novelty=0.5 contradiction=? stateChange=0',
    );
  });
});

describe('value-gate flag resolvers', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['SCENES_VALUE_GATE_ENABLED', 'SCENES_VALUE_GATE_MIN'];
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('the gate defaults OFF', () => {
    expect(sceneValueGateEnabled()).toBe(false);
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    expect(sceneValueGateEnabled()).toBe(true);
  });

  it.each([
    ['unset', undefined, 0.05],
    ['blank', '   ', 0.05],
    ['a valid fraction', '0.2', 0.2],
    ['the no-op floor', '0', 0],
    ['the top of the range', '1', 1],
    ['out of range (>1)', '1.5', 0.05],
    ['negative', '-0.1', 0.05],
    ['not a number', 'high', 0.05],
  ])('SCENES_VALUE_GATE_MIN %s -> %s', (_name, raw, expected) => {
    if (raw === undefined) delete process.env.SCENES_VALUE_GATE_MIN;
    else process.env.SCENES_VALUE_GATE_MIN = raw;
    expect(sceneValueGateMin()).toBe(expected);
  });
});

describe('buildPromotableScenesQuery: the value projections', () => {
  // The pre-gate query, verbatim. "Off is byte-identical" is a string
  // promise, not an equivalence one.
  const HISTORICAL = `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE`;

  it('gate off ⇒ the historical SQL, byte for byte (and unset === false)', () => {
    const off = buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: false });
    expect(off).toEqual({ sql: HISTORICAL, params: { v: 'scene-segmenter-v1' } });
    expect(
      buildPromotableScenesQuery({
        version: 'scene-segmenter-v1',
        packDeltas: false,
        valueGate: false,
      }).sql,
    ).toBe(HISTORICAL);
    expect(off.sql).not.toContain('novelty');
  });

  it('gate on ⇒ exactly the three gated dimensions ride back, no new binds', () => {
    const q = buildPromotableScenesQuery({
      version: 'scene-segmenter-v1',
      packDeltas: false,
      valueGate: true,
    });
    expect(q.sql).toContain('enrichedMemoryValue.novelty AS novelty');
    expect(q.sql).toContain('enrichedMemoryValue.contradiction AS contradiction');
    expect(q.sql).toContain('enrichedMemoryValue.stateChange AS stateChange');
    // Not gated on, so not projected — the write-only dimensions stay
    // write-only rather than becoming an accidental contract.
    expect(q.sql).not.toContain('identity');
    expect(q.sql).not.toContain('estimatedUtility');
    expect(q.params).toEqual({ v: 'scene-segmenter-v1' });
    // Everything the historical query selected is still selected.
    expect(q.sql).toContain('enrichedMemoryValue.explicitness AS explicitness');
    expect(q.sql).toContain('WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE');
  });

  it('gate on composes with the pack leg and the conversation scope', () => {
    const q = buildPromotableScenesQuery({
      version: 'scene-segmenter-v1',
      conversationId: 'conv:a',
      packDeltas: true,
      valueGate: true,
    });
    expect(q.sql).toContain('string::starts_with(segmenterVersion, $packPrefix)');
    expect(q.sql).toContain('enrichedMemoryValue.stateChange AS stateChange');
    expect(q.sql.trimEnd().endsWith('AND conversationIds CONTAINS $conv')).toBe(true);
  });
});

describe('the gate through run() (fake db)', () => {
  /** Records every statement; returns the seeded scene heads. */
  class FakeDb {
    sceneHeads: PromotableSceneHead[] = [];
    sql: string[] = [];
    inserted: Array<Record<string, unknown>> = [];

    async query(sqlText: string, params: Record<string, unknown> = {}): Promise<unknown> {
      this.sql.push(sqlText);
      if (sqlText.includes('FROM memory_episode') && sqlText.includes('stateDeltas')) {
        return [this.sceneHeads];
      }
      if (sqlText.includes('field = $f')) return [[]];
      // The revision lands through the compare-and-set transaction
      // (commitRevision); with no head there is nothing to stamp — only
      // the INSERT IGNORE inside it matters here.
      if (sqlText.startsWith('BEGIN TRANSACTION')) {
        this.inserted.push(...(params.rows as Array<Record<string, unknown>>));
        return [true];
      }
      if (sqlText.includes('UPDATE memory_episode')) return [];
      throw new Error(`FakeDb: unhandled SQL: ${sqlText}`);
    }
  }

  function makeService(db: FakeDb): BeliefPromotionService {
    const surreal = {
      withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>) => fn(db),
    } as unknown as SurrealService;
    const versions = {
      resolve: () => ({ version: 'scene-segmenter-v1' }),
    } as unknown as SceneVersionService;
    const config = { get: (_k: string, def?: string) => def } as unknown as ConfigService;
    return new BeliefPromotionService(surreal, config, versions);
  }

  const scene = (id: string, over: Partial<PromotableSceneHead>): PromotableSceneHead => ({
    id,
    userId: 'u1',
    userIds: ['u1'],
    conversationIds: ['conv:a'],
    occurredTo: '2026-03-01T10:00:00.000Z',
    explicitness: 0.8,
    stateDeltas: [{ subject: 'mika', field: 'home.city', from: '', to: 'lisbon' }],
    ...over,
  });

  /** A scene every producer scored at essentially zero. */
  const noisy = (id: string, over: Partial<PromotableSceneHead> = {}): PromotableSceneHead =>
    scene(id, { novelty: 0.01, contradiction: 0, stateChange: 0, ...over });

  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'SCENES_BELIEF_PROMOTION',
    'SCENES_VALUE_GATE_ENABLED',
    'SCENES_VALUE_GATE_MIN',
    'SCENES_BELIEF_MIN_SCENES',
    'SCENES_BELIEF_FIELD_FOLD',
    'SCENES_BELIEF_LLM_SYNTHESIS',
    'SCENES_PACK_DELTA_PROMOTION',
    'PROVENANCE_SUPPORT_EDGES',
  ];
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SCENES_BELIEF_PROMOTION = '1';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('gate OFF: a demonstrably-noisy scene promotes exactly as today, and the SQL is unchanged', async () => {
    const db = new FakeDb();
    db.sceneHeads = [noisy('memory_episode:s1')];
    const res = await makeService(db).run('co_test');

    expect(res).toMatchObject({
      scenes: 1,
      eligibleScenes: 1,
      skippedLowValue: 0,
      beliefsCreated: 1,
    });
    expect(db.sql[0]).toBe(
      buildPromotableScenesQuery({ version: 'scene-segmenter-v1', packDeltas: false }).sql,
    );
  });

  it('gate ON: the noisy scene is refused, counted, and writes NO belief', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const db = new FakeDb();
    db.sceneHeads = [noisy('memory_episode:s1')];
    const res = await makeService(db).run('co_test');

    expect(res).toMatchObject({
      scenes: 1,
      eligibleScenes: 0,
      skippedLowValue: 1,
      beliefsCreated: 0,
    });
    expect(db.inserted).toEqual([]);
    // The scene was READ (the projection rode back) but never folded.
    expect(db.sql[0]).toContain('enrichedMemoryValue.novelty AS novelty');
  });

  it('gate ON: high contradiction promotes while its all-low sibling is skipped', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const db = new FakeDb();
    db.sceneHeads = [
      noisy('memory_episode:s_noise', {
        stateDeltas: [{ subject: 'mika', field: 'noise', from: '', to: 'x' }],
      }),
      scene('memory_episode:s_signal', { novelty: 0, contradiction: 0.9, stateChange: 0 }),
    ];
    const res = await makeService(db).run('co_test');

    expect(res).toMatchObject({ scenes: 2, eligibleScenes: 1, skippedLowValue: 1 });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ field: 'home.city', value: 'lisbon' });
  });

  it('gate ON: an UNSCORED scene promotes — the gate never empties a world it cannot measure', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const db = new FakeDb();
    // No value vector at all: the pack-projection / legacy / enrichment-off shape.
    db.sceneHeads = [scene('memory_episode:s1', {})];
    const res = await makeService(db).run('co_test');
    expect(res).toMatchObject({ eligibleScenes: 1, skippedLowValue: 0, beliefsCreated: 1 });
  });

  it('gate ON with one dimension missing: still promoted (undefined is not zero)', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const db = new FakeDb();
    db.sceneHeads = [scene('memory_episode:s1', { novelty: 0, stateChange: 0 })];
    const res = await makeService(db).run('co_test');
    expect(res).toMatchObject({ eligibleScenes: 1, skippedLowValue: 0, beliefsCreated: 1 });
  });

  it('the floor is honoured: raising it refuses a scene the default admitted', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const middling = () =>
      scene('memory_episode:s1', { novelty: 0.1, contradiction: 0.1, stateChange: 0.1 });

    const admitted = new FakeDb();
    admitted.sceneHeads = [middling()];
    expect((await makeService(admitted).run('co_test')).skippedLowValue).toBe(0);

    process.env.SCENES_VALUE_GATE_MIN = '0.5';
    const refused = new FakeDb();
    refused.sceneHeads = [middling()];
    expect((await makeService(refused).run('co_test')).skippedLowValue).toBe(1);
  });

  it('the #387 fence still wins: a mixed-user noisy scene counts as mixedUser, not lowValue', async () => {
    process.env.SCENES_VALUE_GATE_ENABLED = '1';
    const db = new FakeDb();
    db.sceneHeads = [noisy('memory_episode:s1', { userIds: ['u1', 'u2'] })];
    const res = await makeService(db).run('co_test');
    expect(res).toMatchObject({ skippedMixedUser: 1, skippedLowValue: 0, eligibleScenes: 0 });
  });
});
