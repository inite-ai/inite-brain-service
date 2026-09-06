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

describe('orphan absorb (SCENES_BELIEF_FIELD_FOLD — run()-level, fake db)', () => {
  /** One semantic_belief row as the fake store holds it. */
  interface FakeBeliefRow {
    id: string;
    userId: string;
    subject: string;
    field: string;
    value: string;
    priorValue?: string;
    revision: number;
    status: string;
    supersededBy?: string;
    validFrom: unknown;
    validUntil?: unknown;
    sourceSceneIds: string[];
    conversationIds: string[];
  }

  /**
   * Minimal stateful SurrealDB double for the promotion pass: routes the
   * service's exact SQL shapes onto an in-memory semantic_belief store
   * (scene stamps are no-ops — pinned by their own e2e). Stateful on
   * purpose: the idempotency test re-runs the SAME world.
   */
  class FakeBeliefDb {
    rows: FakeBeliefRow[] = [];
    sceneHeads: PromotableSceneHead[] = [];
    sql: string[] = [];

    async query(sqlText: string, params: Record<string, unknown> = {}): Promise<unknown> {
      this.sql.push(sqlText);
      const p = params;
      if (sqlText.includes('FROM memory_episode') && sqlText.includes('stateDeltas')) {
        return [this.sceneHeads];
      }
      if (sqlText.includes('SELECT userId, subject, field FROM semantic_belief')) {
        return [
          this.rows
            .filter((r) => r.status === 'active' && (p.userIds as string[]).includes(r.userId))
            .map(({ userId, subject, field }) => ({ userId, subject, field })),
        ];
      }
      if (sqlText.includes('field = $f')) {
        return [
          this.rows
            .filter(
              (r) =>
                r.status === 'active' && r.userId === p.u && r.subject === p.s && r.field === p.f,
            )
            .sort((a, b) => b.revision - a.revision)
            .map((r) => ({ ...r })),
        ];
      }
      if (sqlText.includes('SELECT id, field, value, priorValue, revision, validFrom')) {
        return [
          this.rows
            .filter((r) => r.status === 'active' && r.userId === p.u && r.subject === p.s)
            .map((r) => ({ ...r })),
        ];
      }
      if (sqlText.startsWith('INSERT IGNORE INTO semantic_belief')) {
        for (const raw of p.rows as Array<Record<string, unknown>>) {
          const id = String(raw.id);
          if (this.rows.some((r) => r.id === id)) continue;
          this.rows.push({
            id,
            userId: String(raw.userId),
            subject: String(raw.subject),
            field: String(raw.field),
            value: String(raw.value),
            ...(raw.priorValue !== undefined ? { priorValue: String(raw.priorValue) } : {}),
            revision: raw.revision as number,
            status: String(raw.status),
            validFrom: raw.validFrom,
            sourceSceneIds: (raw.sourceSceneIds as unknown[]).map(String),
            conversationIds: [...(raw.conversationIds as string[])],
          });
        }
        return [];
      }
      if (sqlText.includes(`SET status = 'superseded'`)) {
        const row = this.byId(String(p.id));
        row.status = 'superseded';
        row.supersededBy = String(p.winner ?? p.new);
        row.validUntil = p.until;
        return [];
      }
      if (sqlText.includes('SET priorValue = $prior')) {
        this.byId(String(p.id)).priorValue = String(p.prior);
        return [];
      }
      if (sqlText.includes('SET sourceSceneIds')) {
        const row = this.byId(String(p.id));
        row.sourceSceneIds = (p.scenes as unknown[]).map(String);
        row.conversationIds = [...(p.convs as string[])];
        return [];
      }
      if (sqlText.includes('UPDATE memory_episode')) return [];
      throw new Error(`FakeBeliefDb: unhandled SQL: ${sqlText}`);
    }

    private byId(id: string): FakeBeliefRow {
      const row = this.rows.find((r) => r.id === id);
      if (row === undefined) throw new Error(`FakeBeliefDb: no row ${id}`);
      return row;
    }

    active(field: string, subject = 'Sasha', userId = 'u1'): FakeBeliefRow | undefined {
      return this.rows.find(
        (r) =>
          r.status === 'active' &&
          r.userId === userId &&
          r.subject === subject &&
          r.field === field,
      );
    }
  }

  function makeRunService(db: FakeBeliefDb): BeliefPromotionService {
    const surreal = {
      withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>) => fn(db),
    } as unknown as SurrealService;
    const versions = {
      resolve: () => ({ version: 'scene-segmenter-v1' }),
    } as unknown as SceneVersionService;
    const config = { get: (_key: string, def?: string) => def } as unknown as ConfigService;
    return new BeliefPromotionService(surreal, config, versions);
  }

  /** The s08 measured end-state: canonical + foldable-variant orphan. */
  const belief = (over: Partial<FakeBeliefRow> & { id: string; field: string }): FakeBeliefRow => ({
    userId: 'u1',
    subject: 'Sasha',
    value: 'Lisbon',
    revision: 1,
    status: 'active',
    validFrom: '2026-08-03T19:00:00.000Z',
    sourceSceneIds: ['memory_episode:sa'],
    conversationIds: ['conv:a'],
    ...over,
  });

  const canonicalRow = (over: Partial<FakeBeliefRow> = {}): FakeBeliefRow =>
    belief({
      id: 'semantic_belief:canon1',
      field: 'location',
      value: 'Porto',
      priorValue: 'Lisbon',
      validFrom: '2026-08-18T19:00:00.000Z',
      sourceSceneIds: ['memory_episode:sb'],
      conversationIds: ['conv:b'],
      ...over,
    });

  const orphanRow = (over: Partial<FakeBeliefRow> = {}): FakeBeliefRow =>
    belief({ id: 'semantic_belief:orphan1', field: 'current location', ...over });

  /** Re-promotion of the canonical scene (the repair-on-next-run shape). */
  const canonicalScene = (): PromotableSceneHead =>
    scene({
      id: 'memory_episode:sb',
      conversationIds: ['conv:b'],
      occurredTo: '2026-08-18T19:00:00.000Z',
      stateDeltas: [{ subject: 'Sasha', field: 'location', from: 'Lisbon', to: 'Porto' }],
    });

  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'SCENES_BELIEF_PROMOTION',
    'SCENES_BELIEF_FIELD_FOLD',
    'SCENES_BELIEF_NEGATION_DELTAS',
    'SCENES_BELIEF_LLM_SYNTHESIS',
    'SCENES_BELIEF_MIN_SCENES',
    'PROVENANCE_SUPPORT_EDGES',
  ];
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SCENES_BELIEF_PROMOTION = '1';
    process.env.SCENES_BELIEF_FIELD_FOLD = '1';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('absorbs a foldable-variant orphan: superseded into the canonical belief, which keeps its own value', async () => {
    const db = new FakeBeliefDb();
    db.rows = [canonicalRow(), orphanRow()];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.fieldOrphansAbsorbed).toBe(1);
    expect(res.fieldOrphanAmbiguous).toBe(0);

    const orphan = db.rows.find((r) => r.id === 'semantic_belief:orphan1')!;
    expect(orphan.status).toBe('superseded');
    expect(orphan.supersededBy).toBe('semantic_belief:canon1');
    expect(orphan.validUntil).toBe('2026-08-18T19:00:00.000Z'); // canonical validFrom
    expect(orphan.value).toBe('Lisbon'); // value untouched — mark, never rewrite

    const canonical = db.rows.find((r) => r.id === 'semantic_belief:canon1')!;
    expect(canonical).toMatchObject({
      status: 'active',
      field: 'location',
      value: 'Porto', // the canonical belief wins with its OWN value
      priorValue: 'Lisbon',
      revision: 1,
    });
    // The orphan can no longer serve: no active row under the variant name.
    expect(db.active('current location')).toBeUndefined();
    // priorValue already present — the backfill UPDATE never fires.
    expect(db.sql.some((s) => s.includes('SET priorValue'))).toBe(false);
  });

  it('backfills priorValue from the absorbed orphan ONLY when the canonical belief has none', async () => {
    const db = new FakeBeliefDb();
    const canonical = canonicalRow();
    delete canonical.priorValue;
    db.rows = [canonical, orphanRow()];
    db.sceneHeads = [
      scene({
        id: 'memory_episode:sb',
        conversationIds: ['conv:b'],
        occurredTo: '2026-08-18T19:00:00.000Z',
        // No `from` on the delta — the canonical belief lands prior-less.
        stateDeltas: [{ subject: 'Sasha', field: 'location', from: '', to: 'Porto' }],
      }),
    ];

    const res = await makeRunService(db).run('co_test');
    expect(res.fieldOrphansAbsorbed).toBe(1);
    expect(db.rows.find((r) => r.id === 'semantic_belief:canon1')).toMatchObject({
      value: 'Porto', // own value always wins…
      priorValue: 'Lisbon', // …the orphan contributes ONLY the prior
      status: 'active',
    });
  });

  it('no backfill when the orphan value equals the canonical value (a self-prior is meaningless)', async () => {
    const db = new FakeBeliefDb();
    const canonical = canonicalRow();
    delete canonical.priorValue;
    db.rows = [canonical, orphanRow({ value: 'Porto' })];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.fieldOrphansAbsorbed).toBe(1);
    const head = db.rows.find((r) => r.id === 'semantic_belief:canon1')!;
    expect(head.priorValue).toBeUndefined();
    expect(db.sql.some((s) => s.includes('SET priorValue'))).toBe(false);
  });

  it('re-run is idempotent: the absorbed orphan stays superseded and nothing flip-flops', async () => {
    const db = new FakeBeliefDb();
    db.rows = [canonicalRow(), orphanRow()];
    db.sceneHeads = [canonicalScene()];
    const svc = makeRunService(db);

    const first = await svc.run('co_test');
    expect(first.fieldOrphansAbsorbed).toBe(1);
    const after = JSON.parse(JSON.stringify(db.rows)) as FakeBeliefRow[];

    const second = await svc.run('co_test');
    expect(second.fieldOrphansAbsorbed).toBe(0);
    expect(second.fieldOrphanAmbiguous).toBe(0);
    expect(second).toMatchObject({ beliefsCreated: 0, beliefsRevised: 0 });
    expect(db.rows).toEqual(after); // byte-identical world — converged
  });

  it('never absorbs across a different subject or a different user', async () => {
    const db = new FakeBeliefDb();
    db.rows = [
      canonicalRow(),
      orphanRow(),
      belief({ id: 'semantic_belief:boris1', field: 'current location', subject: 'Boris' }),
      belief({ id: 'semantic_belief:u2row1', field: 'current location', userId: 'u2' }),
    ];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.fieldOrphansAbsorbed).toBe(1); // ONLY (u1, Sasha)'s variant
    expect(db.active('current location', 'Boris')).toBeDefined();
    expect(db.active('current location', 'Sasha', 'u2')).toBeDefined();
  });

  it('flag off: no sweep query, the orphan keeps serving, counters stay zero (byte-identical)', async () => {
    delete process.env.SCENES_BELIEF_FIELD_FOLD;
    const db = new FakeBeliefDb();
    db.rows = [canonicalRow(), orphanRow()];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.fieldOrphansAbsorbed).toBe(0);
    expect(res.fieldOrphanAmbiguous).toBe(0);
    expect(db.active('current location')).toBeDefined(); // untouched
    // Zero fold/sweep queries — the historical query set exactly.
    expect(db.sql.some((s) => s.includes('SELECT userId, subject, field'))).toBe(false);
    expect(db.sql.some((s) => s.includes('priorValue, revision, validFrom'))).toBe(false);
  });

  it('ambiguity guard: two distinct foldable variant fields absorb NOTHING, loudly', async () => {
    const db = new FakeBeliefDb();
    db.rows = [
      belief({
        id: 'semantic_belief:own1',
        subject: 'Mikhail',
        field: 'car ownership',
        value: 'Jeep',
      }),
      belief({
        id: 'semantic_belief:stat1',
        subject: 'Mikhail',
        field: 'car status',
        value: 'broken',
      }),
    ];
    db.sceneHeads = [
      scene({
        id: 'memory_episode:sc',
        conversationIds: ['conv:c'],
        occurredTo: '2026-08-20T10:00:00.000Z',
        stateDeltas: [{ subject: 'Mikhail', field: 'car', from: '', to: 'BMW' }],
      }),
    ];

    const res = await makeRunService(db).run('co_test');
    // Fold-time ambiguity kept the incoming name as a parallel group…
    expect(res.fieldFoldAmbiguous).toBe(1);
    expect(res.beliefsCreated).toBe(1);
    // …and the sweep refuses to merge fields the rule holds distinct.
    expect(res.fieldOrphanAmbiguous).toBe(1);
    expect(res.fieldOrphansAbsorbed).toBe(0);
    expect(db.active('car ownership', 'Mikhail')).toBeDefined();
    expect(db.active('car status', 'Mikhail')).toBeDefined();
    expect(db.active('car', 'Mikhail')).toMatchObject({ value: 'BMW' });
  });

  it('same-run parallel groups never eat each other (the run-group fence)', async () => {
    const db = new FakeBeliefDb();
    db.rows = [
      belief({ id: 'semantic_belief:car1', subject: 'Mikhail', field: 'car', value: 'BMW' }),
      belief({
        id: 'semantic_belief:own1',
        subject: 'Mikhail',
        field: 'car ownership',
        value: 'Jeep',
      }),
    ];
    db.sceneHeads = [
      scene({
        id: 'memory_episode:sc1',
        conversationIds: ['conv:c'],
        occurredTo: '2026-08-20T10:00:00.000Z',
        stateDeltas: [{ subject: 'Mikhail', field: 'car', from: '', to: 'BMW' }],
      }),
      scene({
        id: 'memory_episode:sc2',
        conversationIds: ['conv:d'],
        occurredTo: '2026-08-20T11:00:00.000Z',
        stateDeltas: [{ subject: 'Mikhail', field: 'car ownership', from: '', to: 'Jeep' }],
      }),
    ];

    const res = await makeRunService(db).run('co_test');
    // Both incoming names exact-match their existing chains: two live
    // groups this run — each is fenced from the other's sweep.
    expect(res.fieldOrphansAbsorbed).toBe(0);
    expect(res.fieldOrphanAmbiguous).toBe(0);
    expect(db.active('car', 'Mikhail')).toBeDefined();
    expect(db.active('car ownership', 'Mikhail')).toBeDefined();
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
      fieldOrphansAbsorbed: 0,
      fieldOrphanAmbiguous: 0,
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
