/**
 * Belief promotion (Belief-A, migration 0120) — the pure fold, the #387
 * single-user fence, the deterministic id/statement/version helpers, the
 * belief-aware support-edge shapes, the flag resolvers, and the OFF-state
 * hard guarantee: with SCENES_BELIEF_PROMOTION off the service returns
 * before touching the version resolver OR the database (zero queries —
 * byte-identical prod; the route's 404 is pinned in the e2e).
 */
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { SceneVersionService } from '../src/admin/scene-version';
import {
  BELIEF_NEGATION_VALUE,
  BELIEF_PROMOTER_VERSION,
  BeliefPromotionService,
  beliefIdTail,
  beliefPromoterVersion,
  fieldsFold,
  foldBeliefGroups,
  renderBeliefStatement,
  resolveFieldFold,
  sceneSingleUser,
  type PromotableSceneHead,
} from '../src/admin/belief-promotion.service';
import {
  SUPPORT_EDGE_WRITERS,
  assertEdgeShape,
  classifySupportTarget,
} from '../src/common/support-edges';
import {
  sceneBeliefFieldFoldEnabled,
  sceneBeliefLlmSynthesisEnabled,
  sceneBeliefMinScenes,
  sceneBeliefNegationDeltasEnabled,
  sceneBeliefPromotionEnabled,
} from '../src/common/scene-flags';

const scene = (over: Partial<PromotableSceneHead> & { id: string }): PromotableSceneHead => ({
  userId: 'u1',
  userIds: ['u1'],
  conversationIds: ['conv:a'],
  occurredTo: '2026-03-01T10:00:00.000Z',
  stateDeltas: [],
  explicitness: 0.8,
  ...over,
});

const delta = (subject: string, field: string, to: string, from = '') => ({
  subject,
  field,
  from,
  to,
});

describe('sceneSingleUser (#387 fail-closed fence)', () => {
  it('admits exactly the single-user shape', () => {
    expect(sceneSingleUser(scene({ id: 's1' }))).toBe('u1');
  });

  it.each([
    ['mixed group', { userIds: ['u1', 'u2'] }],
    ['legacy pre-0117 (userIds missing)', { userIds: undefined }],
    ['tenant-global (userIds empty)', { userIds: [] }],
    ['userId stamp disagrees with the member set', { userId: 'u2' }],
    ['userId stamp missing', { userId: undefined }],
    ['non-string member', { userIds: [42] }],
  ])('rejects %s', (_name, over) => {
    expect(sceneSingleUser(scene({ id: 's1', ...over }))).toBeNull();
  });
});

describe('foldBeliefGroups', () => {
  it('folds one delta into one verdict with template-ready fields', () => {
    const { folded, conflicts } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s1',
          stateDeltas: [delta('mika', 'home.city', 'lisbon')],
        }),
      },
    ]);
    expect(conflicts).toEqual([]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      userId: 'u1',
      subject: 'mika',
      field: 'home.city',
      value: 'lisbon',
      priorValue: '',
      sceneIds: ['memory_episode:s1'],
      conversationIds: ['conv:a'],
    });
    expect(folded[0]!.validFrom.toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('latest value wins; earlier values are history, corroboration counts the winning set', () => {
    const { folded } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s1',
          occurredTo: '2026-03-01T10:00:00.000Z',
          stateDeltas: [delta('mika', 'home.city', 'porto')],
        }),
      },
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s2',
          conversationIds: ['conv:b'],
          occurredTo: '2026-03-02T10:00:00.000Z',
          stateDeltas: [delta('mika', 'home.city', 'lisbon', 'porto')],
        }),
      },
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s3',
          conversationIds: ['conv:c'],
          occurredTo: '2026-03-03T10:00:00.000Z',
          stateDeltas: [delta('mika', 'home.city', 'lisbon')],
        }),
      },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      value: 'lisbon',
      priorValue: '',
      sceneIds: ['memory_episode:s2', 'memory_episode:s3'],
      conversationIds: ['conv:b', 'conv:c'],
    });
    expect(folded[0]!.validFrom.toISOString()).toBe('2026-03-03T10:00:00.000Z');
  });

  it('conflict guard: two different values at the winning timestamp skip the whole group', () => {
    const { folded, conflicts } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s1',
          stateDeltas: [delta('mika', 'job.title', 'engineer')],
        }),
      },
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s2',
          stateDeltas: [delta('mika', 'job.title', 'designer')],
        }),
      },
    ]);
    expect(folded).toEqual([]);
    expect(conflicts).toEqual([
      { userId: 'u1', subject: 'mika', field: 'job.title', values: ['designer', 'engineer'] },
    ]);
  });

  it('groups are per (userId, subject, field) — different users never merge', () => {
    const { folded, conflicts } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({ id: 'memory_episode:s1', stateDeltas: [delta('mika', 'pet', 'cat')] }),
      },
      {
        userId: 'u2',
        scene: scene({
          id: 'memory_episode:s2',
          userId: 'u2',
          userIds: ['u2'],
          stateDeltas: [delta('mika', 'pet', 'dog')],
        }),
      },
    ]);
    expect(conflicts).toEqual([]);
    expect(folded.map((f) => [f.userId, f.value])).toEqual([
      ['u1', 'cat'],
      ['u2', 'dog'],
    ]);
  });

  it('drops deltas without subject/field/landing value and unordered scenes', () => {
    const { folded } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s1',
          stateDeltas: [
            delta('', 'field', 'v'),
            delta('subject', '', 'v'),
            delta('subject', 'field', ''),
            'not-an-object',
          ],
        }),
      },
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s2',
          occurredTo: undefined,
          stateDeltas: [delta('mika', 'pet', 'cat')],
        }),
      },
    ]);
    expect(folded).toEqual([]);
  });

  it('confidence = mean explicitness + distinct-conversation bonus, capped', () => {
    const { folded } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s1',
          explicitness: 0.6,
          stateDeltas: [delta('mika', 'pet', 'cat')],
        }),
      },
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s2',
          conversationIds: ['conv:b'],
          occurredTo: '2026-03-02T10:00:00.000Z',
          explicitness: 0.8,
          stateDeltas: [delta('mika', 'pet', 'cat')],
        }),
      },
    ]);
    // mean(0.6, 0.8) + 0.05 * (2 distinct conversations - 1) = 0.75
    expect(folded[0]!.confidence).toBe(0.75);
    const { folded: capped } = foldBeliefGroups([
      {
        userId: 'u1',
        scene: scene({
          id: 'memory_episode:s3',
          explicitness: 0.99,
          stateDeltas: [delta('mika', 'pet', 'cat')],
        }),
      },
    ]);
    expect(capped[0]!.confidence).toBe(0.95);
  });
});

describe('field fold rule (SCENES_BELIEF_FIELD_FOLD, #135 seam 2)', () => {
  it.each([
    // [a, b, folds?] — the #135 decision table, verbatim.
    ['car', 'car ownership', true], // extra token 'ownership' is generic
    ['queue backend', 'queue', false], // 'backend' not in the stoplist — conservative
    ['car', 'career', false], // different tokens entirely
    ['deploy target', 'deployment target', false], // no stemming: 'deploy' ≠ 'deployment'
    ['car registration', 'car', false], // registration is a DIFFERENT attribute
    ['car', 'car', true], // identity
    ['Car', 'car', true], // normalization: case
    ['car.status', 'car', true], // normalization: punctuation + generic extra
  ])('fieldsFold(%p, %p) === %p (symmetric)', (a, b, expected) => {
    expect(fieldsFold(a as string, b as string)).toBe(expected);
    expect(fieldsFold(b as string, a as string)).toBe(expected);
  });

  it('resolveFieldFold: exactly one candidate folds — the EXISTING name wins', () => {
    expect(resolveFieldFold('car ownership', ['car', 'home.city'])).toEqual({
      field: 'car',
      folded: true,
      ambiguous: false,
      candidates: ['car'],
    });
    // Stability holds in the other direction too: incoming shorter name
    // folds onto the longer EXISTING one.
    expect(resolveFieldFold('car', ['car ownership'])).toMatchObject({
      field: 'car ownership',
      folded: true,
    });
  });

  it('resolveFieldFold: no candidate keeps the incoming name', () => {
    expect(resolveFieldFold('car registration', ['car'])).toEqual({
      field: 'car registration',
      folded: false,
      ambiguous: false,
      candidates: [],
    });
  });

  it('resolveFieldFold: an exact existing match short-circuits (never re-folded)', () => {
    // 'car' exists verbatim next to a foldable variant — the exact name
    // is already canonical; folding it would flip-flop parallel chains.
    expect(resolveFieldFold('car', ['car', 'car ownership'])).toEqual({
      field: 'car',
      folded: false,
      ambiguous: false,
      candidates: [],
    });
  });

  it('resolveFieldFold: MORE than one match is ambiguous — fold nothing', () => {
    expect(resolveFieldFold('car', ['car ownership', 'car status'])).toEqual({
      field: 'car',
      folded: false,
      ambiguous: true,
      candidates: ['car ownership', 'car status'],
    });
  });
});

describe('foldBeliefGroups: negation deltas (#135 seam 1)', () => {
  const negationScene = scene({
    id: 'memory_episode:s1',
    stateDeltas: [{ subject: 'mikhail', field: 'car', from: 'Compass', to: '' }],
  });

  it('no opts: empty-`to` deltas drop exactly as today (byte-identical)', () => {
    const withoutOpts = foldBeliefGroups([{ userId: 'u1', scene: negationScene }]);
    const flagOff = foldBeliefGroups([{ userId: 'u1', scene: negationScene }], {
      negationDeltas: false,
    });
    expect(withoutOpts.folded).toEqual([]);
    expect(flagOff).toEqual(withoutOpts);
  });

  it('flag on: empty-`to` + non-empty `from` admits the sentinel, priorValue kept', () => {
    const { folded, conflicts } = foldBeliefGroups([{ userId: 'u1', scene: negationScene }], {
      negationDeltas: true,
    });
    expect(conflicts).toEqual([]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      subject: 'mikhail',
      field: 'car',
      value: BELIEF_NEGATION_VALUE,
      priorValue: 'Compass',
    });
  });

  it('flag on: empty-`to` + empty `from` stays dropped (nothing to negate)', () => {
    const { folded } = foldBeliefGroups(
      [
        {
          userId: 'u1',
          scene: scene({
            id: 'memory_episode:s1',
            stateDeltas: [{ subject: 'mikhail', field: 'car', from: '', to: '' }],
          }),
        },
      ],
      { negationDeltas: true },
    );
    expect(folded).toEqual([]);
  });
});

describe('foldBeliefGroups: field fold (#135 seam 2)', () => {
  const compassScenes = [
    {
      userId: 'u1',
      scene: scene({
        id: 'memory_episode:s1',
        occurredTo: '2026-03-01T10:00:00.000Z',
        stateDeltas: [{ subject: 'Mikhail', field: 'car', from: '', to: 'Jeep Compass' }],
      }),
    },
    {
      userId: 'u1',
      scene: scene({
        id: 'memory_episode:s2',
        conversationIds: ['conv:b'],
        occurredTo: '2026-03-02T10:00:00.000Z',
        stateDeltas: [{ subject: 'Mikhail', field: 'car ownership', from: 'Compass', to: '' }],
      }),
    },
  ];

  it('flag(s) off: the Compass fixture is byte-identical to today (one group, negation dropped)', () => {
    const fold = foldBeliefGroups(compassScenes);
    expect(fold.folded).toHaveLength(1);
    expect(fold.folded[0]).toMatchObject({ field: 'car', value: 'Jeep Compass' });
    expect(fold.fieldFolds).toEqual([]);
    expect(fold.fieldFoldAmbiguities).toEqual([]);
  });

  it('both flags on: the two-scene Compass batch converges to ONE group with the negation winner', () => {
    const { folded, conflicts, fieldFolds } = foldBeliefGroups(compassScenes, {
      negationDeltas: true,
      existingFields: new Map(),
    });
    expect(conflicts).toEqual([]);
    expect(folded).toHaveLength(1);
    // 'car ownership' folded onto the batch-seen 'car'; latest wins.
    expect(folded[0]).toMatchObject({
      userId: 'u1',
      subject: 'Mikhail',
      field: 'car',
      value: BELIEF_NEGATION_VALUE,
      priorValue: 'Compass',
      sceneIds: ['memory_episode:s2'],
    });
    expect(fieldFolds).toEqual([
      { userId: 'u1', subject: 'Mikhail', from: 'car ownership', to: 'car' },
    ]);
  });

  it('folds onto an EXISTING belief field from the map (the live two-run shape)', () => {
    const { folded, fieldFolds } = foldBeliefGroups([compassScenes[1]!], {
      negationDeltas: true,
      existingFields: new Map([['u1\x00Mikhail', ['car']]]),
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ field: 'car', value: BELIEF_NEGATION_VALUE });
    expect(fieldFolds).toEqual([
      { userId: 'u1', subject: 'Mikhail', from: 'car ownership', to: 'car' },
    ]);
  });

  it('ambiguity: two existing fields both matching — no fold, reported loudly', () => {
    const { folded, fieldFolds, fieldFoldAmbiguities } = foldBeliefGroups(
      [
        {
          userId: 'u1',
          scene: scene({
            id: 'memory_episode:s1',
            stateDeltas: [{ subject: 'Mikhail', field: 'car', from: '', to: 'Jeep Compass' }],
          }),
        },
      ],
      {
        existingFields: new Map([['u1\x00Mikhail', ['car ownership', 'car status']]]),
      },
    );
    // The incoming name is KEPT — a parallel group beats a wrong merge.
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ field: 'car' });
    expect(fieldFolds).toEqual([]);
    expect(fieldFoldAmbiguities).toEqual([
      {
        userId: 'u1',
        subject: 'Mikhail',
        field: 'car',
        candidates: ['car ownership', 'car status'],
      },
    ]);
  });
});

describe('deterministic helpers', () => {
  it('renderBeliefStatement: template with and without a prior value', () => {
    expect(
      renderBeliefStatement({
        subject: 'mika',
        field: 'home.city',
        value: 'lisbon',
        priorValue: '',
      }),
    ).toBe('mika — home.city: lisbon');
    expect(
      renderBeliefStatement({
        subject: 'mika',
        field: 'home.city',
        value: 'lisbon',
        priorValue: 'porto',
      }),
    ).toBe('mika — home.city: lisbon (was: porto)');
    // #135 seam 1: the sentinel renders through the SAME template — no
    // special-casing anywhere downstream.
    expect(
      renderBeliefStatement({
        subject: 'Mikhail',
        field: 'car',
        value: BELIEF_NEGATION_VALUE,
        priorValue: 'Jeep Compass',
      }),
    ).toBe('Mikhail — car: none (was: Jeep Compass)');
  });

  it('beliefIdTail is deterministic per (user, subject, field, revision)', () => {
    const key = { userId: 'u1', subject: 'mika', field: 'home.city' };
    const a = beliefIdTail(key, 1);
    expect(a).toBe(beliefIdTail(key, 1));
    expect(a).toHaveLength(24);
    expect(a).not.toBe(beliefIdTail(key, 2));
    expect(a).not.toBe(beliefIdTail({ ...key, userId: 'u2' }, 1));
  });

  it('beliefPromoterVersion is the readable promoter|world composite', () => {
    expect(beliefPromoterVersion('scene-segmenter-v1')).toBe(
      `${BELIEF_PROMOTER_VERSION}|scene-segmenter-v1`,
    );
  });
});

describe('support-edge shapes for beliefs (0120)', () => {
  it('belief_promotion is a registered writer', () => {
    expect(SUPPORT_EDGE_WRITERS).toContain('belief_promotion');
  });

  it('classifies the semantic_belief prefix', () => {
    expect(classifySupportTarget('semantic_belief:abc')).toBe('belief');
  });

  it('supported_by: belief -> scene only', () => {
    expect(assertEdgeShape('supported_by', 'semantic_belief:b1', 'memory_episode:s1')).toBe(true);
    expect(assertEdgeShape('supported_by', 'semantic_belief:b1', 'knowledge_fact:f1')).toBe(false);
  });

  it('contradicted_by / derived_from: belief pairs only with belief (never the claim plane)', () => {
    expect(assertEdgeShape('contradicted_by', 'semantic_belief:b1', 'semantic_belief:b2')).toBe(
      true,
    );
    expect(assertEdgeShape('derived_from', 'semantic_belief:b2', 'semantic_belief:b1')).toBe(true);
    expect(assertEdgeShape('contradicted_by', 'semantic_belief:b1', 'knowledge_fact:f1')).toBe(
      false,
    );
    expect(assertEdgeShape('derived_from', 'knowledge_fact:f1', 'semantic_belief:b1')).toBe(false);
  });

  it('fact rules are byte-identical to pre-0120', () => {
    expect(assertEdgeShape('supported_by', 'knowledge_fact:f1', 'memory_episode:s1')).toBe(true);
    expect(assertEdgeShape('contradicted_by', 'knowledge_fact:f1', 'knowledge_fact:f2')).toBe(true);
    expect(assertEdgeShape('derived_from', 'knowledge_fact:f1', 'knowledge_fact:f2')).toBe(true);
    expect(assertEdgeShape('reconstructed_from', 'knowledge_fact:f1', 'memory_episode:s1')).toBe(
      false,
    );
    expect(assertEdgeShape('reconstructed_from', 'semantic_belief:b1', 'memory_episode:s1')).toBe(
      false,
    );
  });
});

describe('flag resolvers', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'SCENES_BELIEF_PROMOTION',
    'SCENES_BELIEF_LLM_SYNTHESIS',
    'SCENES_BELIEF_MIN_SCENES',
    'SCENES_BELIEF_NEGATION_DELTAS',
    'SCENES_BELIEF_FIELD_FOLD',
  ];
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

  it('all four booleans default off', () => {
    expect(sceneBeliefPromotionEnabled()).toBe(false);
    expect(sceneBeliefLlmSynthesisEnabled()).toBe(false);
    expect(sceneBeliefNegationDeltasEnabled()).toBe(false);
    expect(sceneBeliefFieldFoldEnabled()).toBe(false);
    process.env.SCENES_BELIEF_PROMOTION = '1';
    process.env.SCENES_BELIEF_LLM_SYNTHESIS = '1';
    process.env.SCENES_BELIEF_NEGATION_DELTAS = '1';
    process.env.SCENES_BELIEF_FIELD_FOLD = '1';
    expect(sceneBeliefPromotionEnabled()).toBe(true);
    expect(sceneBeliefLlmSynthesisEnabled()).toBe(true);
    expect(sceneBeliefNegationDeltasEnabled()).toBe(true);
    expect(sceneBeliefFieldFoldEnabled()).toBe(true);
  });

  it('SCENES_BELIEF_MIN_SCENES: non-negative int, 0 = off, invalid -> 0', () => {
    expect(sceneBeliefMinScenes()).toBe(0);
    process.env.SCENES_BELIEF_MIN_SCENES = '2';
    expect(sceneBeliefMinScenes()).toBe(2);
    process.env.SCENES_BELIEF_MIN_SCENES = '0';
    expect(sceneBeliefMinScenes()).toBe(0);
    for (const bad of ['-1', '1.5', 'x', ' ']) {
      process.env.SCENES_BELIEF_MIN_SCENES = bad;
      expect(sceneBeliefMinScenes()).toBe(0);
    }
  });
});

describe('OFF-state hard guarantee (byte-identical prod)', () => {
  const savedFlag = process.env.SCENES_BELIEF_PROMOTION;
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.SCENES_BELIEF_PROMOTION;
    else process.env.SCENES_BELIEF_PROMOTION = savedFlag;
  });

  function makeService(): BeliefPromotionService {
    // Every collaborator THROWS on touch: with the flag off the run must
    // return before resolving the version or opening a db handle.
    const surreal = {
      withCompany: () => {
        throw new Error('withCompany must not be called with the flag off');
      },
    } as unknown as SurrealService;
    const versions = {
      resolve: () => {
        throw new Error('SceneVersionService.resolve must not be called with the flag off');
      },
    } as unknown as SceneVersionService;
    const config = {
      get: (_key: string, def?: string) => def,
    } as unknown as ConfigService;
    return new BeliefPromotionService(surreal, config, versions);
  }

  it('flag off ⇒ zero queries, zero version resolution, all-zero result', async () => {
    delete process.env.SCENES_BELIEF_PROMOTION;
    const result = await makeService().run('co_test');
    expect(result).toEqual({
      scenes: 0,
      eligibleScenes: 0,
      skippedMixedUser: 0,
      skippedConflict: 0,
      fieldFolds: 0,
      fieldFoldAmbiguous: 0,
      skippedFloor: 0,
      skippedStale: 0,
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
      supportEdges: 0,
    });
  });

  it('LLM synthesis default-off: statements are deterministic templates (no client needed)', async () => {
    const svc = makeService();
    const composed = await (
      svc as unknown as {
        composeStatement: (f: {
          subject: string;
          field: string;
          value: string;
          priorValue: string;
        }) => Promise<{ text: string; source: string }>;
      }
    ).composeStatement({ subject: 'mika', field: 'pet', value: 'cat', priorValue: '' });
    expect(composed).toEqual({ text: 'mika — pet: cat', source: 'template' });
  });
});
