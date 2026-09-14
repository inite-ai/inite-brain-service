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
  foldBeliefGroups,
  renderBeliefStatement,
  sceneSingleUser,
  type PromotableSceneHead,
} from '../src/admin/belief-promotion.service';
import { predicateIdFromFieldName } from '../src/common/attribute-names';
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
      // The chain's previous distinct value — what the current state
      // displaced — not the winner delta's own (empty) `from`.
      priorValue: 'porto',
      sceneIds: ['memory_episode:s2', 'memory_episode:s3'],
      allSceneIds: ['memory_episode:s1', 'memory_episode:s2', 'memory_episode:s3'],
      conversationIds: ['conv:b', 'conv:c'],
    });
    // TWO CLOCKS (F6): the state BEGAN with the run's opener (s2) — a
    // later confirmation (s3) is the evidence watermark, not the start.
    expect(folded[0]!.validFrom.toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(folded[0]!.evidenceAt.toISOString()).toBe('2026-03-03T10:00:00.000Z');
    expect(folded[0]!.runEvidenceAt.map((d) => d.toISOString())).toEqual([
      '2026-03-02T10:00:00.000Z',
      '2026-03-03T10:00:00.000Z',
    ]);
  });

  it('an interlude of another value restarts the state: validFrom is the run AFTER it', () => {
    // A on Jan 1, B on Feb 1, A on Mar 1: the current state is A since
    // MARCH — the January A corroborates the value but the beginning
    // does not reach back past the February interlude.
    const at = (id: string, day: string, value: string, from = '') => ({
      userId: 'u1',
      scene: scene({
        id: `memory_episode:${id}`,
        conversationIds: [`conv:${id}`],
        occurredTo: `2026-${day}T00:00:00.000Z`,
        stateDeltas: [delta('alice', 'city', value, from)],
      }),
    });
    const { folded } = foldBeliefGroups([
      at('t3', '03-01', 'A'),
      at('t1', '01-01', 'A'),
      at('t2', '02-01', 'B'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      value: 'A',
      priorValue: 'B',
      sceneIds: ['memory_episode:t1', 'memory_episode:t3'],
    });
    expect(folded[0]!.validFrom.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(folded[0]!.evidenceAt.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(folded[0]!.runEvidenceAt).toHaveLength(1);
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
      {
        userId: 'u1',
        subject: 'mika',
        field: 'job.title',
        values: ['designer', 'engineer'],
        allSceneIds: ['memory_episode:s1', 'memory_episode:s2'],
      },
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

/**
 * The attribute-name normalizer that replaced the lexical fold rule.
 *
 * What was here: `fieldsFold`, a token-subset test over a hand-written
 * six-word stoplist of "generic modifiers", and `resolveFieldFold`, the
 * incoming-name router built on it. Both are gone. Measured against the
 * twelve field names a live tenant held, that rule folded ZERO pairs and
 * missed all three it existed to catch — `deployment target` ~
 * `deployment platform`, `job queue backend` ~ `queue backend`, `pilot
 * launch date` ~ `date` — two of which its own doc conceded as accepted
 * limitations. Attribute identity is the predicate registry's job on
 * both planes now (0147); what remains here is only the free-text →
 * predicate-id normalization that lets a belief field enter it.
 */
describe('predicateIdFromFieldName — free text into the registry', () => {
  it.each([
    ['deployment target', 'deployment_target'],
    ['job queue backend', 'job_queue_backend'],
    ['HTTP service port', 'http_service_port'],
    ['pilot launch date', 'pilot_launch_date'],
    // Already an id: idempotent, so a re-run resolves to the same slot.
    ['retry_policy', 'retry_policy'],
    // Dotted paths the enricher emits.
    ['home.city', 'home_city'],
    ['car.status', 'car_status'],
    // The three-character floor drops tokens that carry no naming
    // signal — the SAME floor contentTokens applies on the fact plane,
    // deliberately shared so the two planes cannot drift apart.
    ['id of car', 'car'],
    // Nothing survives the floor: no slot, and the caller keeps the
    // written name rather than inventing one.
    ['id', ''],
    ['', ''],
  ])('predicateIdFromFieldName(%p) === %p', (input, expected) => {
    expect(predicateIdFromFieldName(input as string)).toBe(expected);
  });

  it('is NOT a morphology table — naming variants stay distinct here', () => {
    // `deployment_target` and `deploy_target` are different coinages and
    // this function says so. Deciding they are one attribute needs the
    // whole vocabulary and the freedom to revisit an earlier answer,
    // which is PredicateConsolidationService's job — it made exactly
    // that merge on the live tenant this normalizer was measured on.
    expect(predicateIdFromFieldName('deployment target')).not.toBe(
      predicateIdFromFieldName('deploy target'),
    );
  });

  it('gives the live tenant its cross-plane join back', () => {
    // The four field names that, normalized, land on a predicate the
    // fact plane had already coined for the SAME subject. Under the
    // lexical rule none of the twelve did.
    const factPredicates = new Set([
      'pilot_launch_date',
      'retry_policy',
      'queue_backend',
      'staging_namespace',
    ]);
    const beliefFields = [
      'idempotency key',
      'date',
      'deployment target',
      'pilot launch date',
      'verification status',
      'retry policy',
      'job queue backend',
      'queue backend',
      'HTTP service port',
      'payout batch size',
      'staging namespace',
      'deployment platform',
    ];
    const joined = beliefFields.filter((f) => factPredicates.has(predicateIdFromFieldName(f)));
    expect(joined).toEqual([
      'pilot launch date',
      'retry policy',
      'queue backend',
      'staging namespace',
    ]);
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

describe('foldBeliefGroups: grouping on the registry slot (0147)', () => {
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

  it('no slots: exact-string grouping, byte-identical to the historical fold', () => {
    const fold = foldBeliefGroups(compassScenes);
    expect(fold.folded).toHaveLength(1);
    expect(fold.folded[0]).toMatchObject({ field: 'car', value: 'Jeep Compass' });
    expect(fold.fieldFolds).toEqual([]);
  });

  it('two names that resolve to ONE slot become one group, latest wins', () => {
    // What the registry says is the whole input. Here `car ownership`
    // was coined earlier and aliased onto `car`, so canonicalize returns
    // `car` for both — the promoter never re-decides that.
    const { folded, conflicts, fieldFolds } = foldBeliefGroups(compassScenes, {
      negationDeltas: true,
      fieldSlots: new Map([
        ['car', 'car'],
        ['car ownership', 'car'],
      ]),
    });
    expect(conflicts).toEqual([]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      userId: 'u1',
      subject: 'Mikhail',
      // Display keeps the FIRST written name; identity is the slot.
      field: 'car',
      predicateId: 'car',
      value: BELIEF_NEGATION_VALUE,
      // The chain's ACTUAL displaced value ('Jeep Compass', from s1) beats
      // the negation delta's own claimed `from` ('Compass') — the same
      // rule the revise path applies against a stored head.
      priorValue: 'Jeep Compass',
      sceneIds: ['memory_episode:s2'],
    });
    expect(fieldFolds).toEqual([
      { userId: 'u1', subject: 'Mikhail', from: 'car ownership', to: 'car' },
    ]);
  });

  it('a single later scene lands in the slot an earlier run already used', () => {
    const { folded, fieldFolds } = foldBeliefGroups([compassScenes[1]!], {
      negationDeltas: true,
      fieldSlots: new Map([['car ownership', 'car']]),
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      field: 'car ownership',
      predicateId: 'car',
      value: BELIEF_NEGATION_VALUE,
    });
    expect(fieldFolds).toEqual([
      { userId: 'u1', subject: 'Mikhail', from: 'car ownership', to: 'car' },
    ]);
  });

  it('names the registry keeps APART stay two groups', () => {
    // The replaced lexical rule had an ambiguity branch for "matches
    // several existing names at once" and had to refuse the whole fold.
    // A registry lookup returns one canon or none, so the case is gone:
    // two slots are simply two groups, which is what parallel attributes
    // are.
    const { folded, fieldFolds } = foldBeliefGroups(
      [
        {
          userId: 'u1',
          scene: scene({
            id: 'memory_episode:s1',
            stateDeltas: [
              { subject: 'Mikhail', field: 'car ownership', from: '', to: 'Jeep Compass' },
              { subject: 'Mikhail', field: 'car status', from: '', to: 'in service' },
            ],
          }),
        },
      ],
      {
        fieldSlots: new Map([
          ['car ownership', 'car_ownership'],
          ['car status', 'car_status'],
        ]),
      },
    );
    expect(folded).toHaveLength(2);
    expect(folded.map((f) => f.predicateId).sort()).toEqual(['car_ownership', 'car_status']);
    expect(fieldFolds).toHaveLength(2);
  });

  it('an unresolvable field keeps its written name and joins nothing', () => {
    // Registry unreachable, or nothing survived the token floor. The
    // group still forms — a promotion pass must not stop for it — and
    // the belief simply has no cross-plane identity, which is exactly
    // what every pre-0147 row has.
    const { folded, fieldFolds } = foldBeliefGroups([compassScenes[0]!], {
      fieldSlots: new Map(),
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ field: 'car', predicateId: 'car' });
    expect(fieldFolds).toEqual([]);
  });
});

describe('one slot, one active row (run()-level, fake db)', () => {
  /** One semantic_belief row as the fake store holds it. */
  interface FakeBeliefRow {
    id: string;
    userId: string;
    subject: string;
    /** The written name — display only since 0147. */
    field: string;
    /** The registry slot; absent models a row written before 0147. */
    predicateId?: string;
    /** The canon the slot was later aliased onto. */
    predicateAlias?: string;
    value: string;
    priorValue?: string;
    revision: number;
    status: string;
    supersededBy?: string;
    validFrom: unknown;
    validUntil?: unknown;
    /** 0137 evidence watermark. */
    latestEvidenceAt?: unknown;
    sourceSceneIds: string[];
    conversationIds: string[];
  }

  /** A stored datetime (Date or ISO string) as epoch ms. */
  const epoch = (v: unknown): number =>
    v instanceof Date ? v.getTime() : new Date(String(v)).getTime();

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
    /** Runs right before a commitRevision transaction — a concurrent writer's move. */
    beforeTransaction?: (() => void) | undefined;

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
      // The chain head, keyed on the SLOT (0147): a row's own
      // predicateAlias ?? predicateId, falling back to its written name
      // for a row that predates the column — which is what the real
      // `(predicateAlias ?? predicateId ?? field)` expression does.
      if (sqlText.includes('(predicateAlias ?? predicateId ?? field) = $slot')) {
        return [
          this.rows
            .filter(
              (r) =>
                r.status === 'active' &&
                r.userId === p.u &&
                r.subject === p.s &&
                (r.predicateAlias ?? r.predicateId ?? r.field) === p.slot,
            )
            .sort((a, b) => b.revision - a.revision)
            .map((r) => ({ ...r })),
        ];
      }
      if (sqlText.includes('SELECT id, field, value, priorValue, revision, validFrom')) {
        return [
          this.rows
            .filter((r) => r.status === 'active' && r.userId === p.u && r.subject === p.s)
            .map((r) => ({ ...r, slot: r.predicateAlias ?? r.predicateId })),
        ];
      }
      // commitRevision: the compare-and-set transaction (BEGIN … COMMIT).
      // Modelled statement by statement: the revision-slot check, the
      // INSERT IGNORE, and — on a revise — the guarded supersede stamp
      // whose miss aborts the whole transaction (the real server rolls
      // the INSERT back on THROW; here nothing was inserted yet when the
      // stamp is checked first, which is observably the same).
      if (sqlText.startsWith('BEGIN TRANSACTION')) {
        // A concurrent writer's move, injected between the run's head read
        // and its transaction — the contention seam the CAS exists for.
        this.beforeTransaction?.();
        const newId = String(p.newId);
        const held = this.rows.find((r) => r.id === newId);
        if (held !== undefined && held.value !== String(p.value)) {
          throw new Error('The query was not executed due to a failed transaction');
        }
        if (p.headId !== undefined) {
          const head = this.rows.find((r) => r.id === String(p.headId));
          // The guarded stamp models the FULL predicate: status, revision
          // AND the watermark the run read (a corroboration moves only the
          // watermark, so without it the CAS misses a moved head).
          const boundWm = p.wm === null || p.wm === undefined ? undefined : epoch(p.wm);
          const rowWm =
            head?.latestEvidenceAt === undefined ? undefined : epoch(head.latestEvidenceAt);
          if (
            head === undefined ||
            head.status !== 'active' ||
            head.revision !== p.headRevision ||
            (rowWm !== undefined && rowWm !== boundWm)
          ) {
            throw new Error('The query was not executed due to a failed transaction');
          }
          head.status = 'superseded';
          head.supersededBy = newId;
          head.validUntil = p.until;
        }
        this.insertIgnore(p.rows as Array<Record<string, unknown>>);
        return [true];
      }
      if (sqlText.startsWith('INSERT IGNORE INTO semantic_belief')) {
        this.insertIgnore(p.rows as Array<Record<string, unknown>>);
        return [];
      }
      if (sqlText.includes(`SET status = 'superseded'`)) {
        const row = this.byId(String(p.id));
        row.status = 'superseded';
        row.supersededBy = String(p.winner ?? p.new);
        row.validUntil = p.until;
        return [];
      }
      // The in-place corroboration UPDATE: whichever of the counters /
      // watermark / realignment assignments the service composed.
      if (sqlText.startsWith('UPDATE $id SET')) {
        const row = this.byId(String(p.id));
        if (p.scenes !== undefined) row.sourceSceneIds = (p.scenes as unknown[]).map(String);
        if (p.convs !== undefined) row.conversationIds = [...(p.convs as string[])];
        if (p.evidenceAt !== undefined) row.latestEvidenceAt = p.evidenceAt;
        if (p.validFrom !== undefined) row.validFrom = p.validFrom;
        if (p.prior !== undefined) row.priorValue = String(p.prior);
        return [];
      }
      // Scene stamps are no-ops here (pinned by their own e2e), including
      // the namespaced baselineRef read-then-write: no scene row exists,
      // so the merge writes nothing.
      if (sqlText.startsWith('SELECT id, baselineRef FROM memory_episode')) return [[]];
      if (sqlText.includes('UPDATE memory_episode') || sqlText.includes('UPDATE $scene')) return [];
      throw new Error(`FakeBeliefDb: unhandled SQL: ${sqlText}`);
    }

    private byId(id: string): FakeBeliefRow {
      const row = this.rows.find((r) => r.id === id);
      if (row === undefined) throw new Error(`FakeBeliefDb: no row ${id}`);
      return row;
    }

    private insertIgnore(rows: Array<Record<string, unknown>>): void {
      for (const raw of rows) {
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
          ...(raw.latestEvidenceAt !== undefined ? { latestEvidenceAt: raw.latestEvidenceAt } : {}),
          sourceSceneIds: (raw.sourceSceneIds as unknown[]).map(String),
          conversationIds: [...(raw.conversationIds as string[])],
        });
      }
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

  function makeRunService(
    db: FakeBeliefDb,
    /**
     * What the registry answers, by predicate id. Empty = identity, the
     * shape of a registry that has coined each name separately. Supply an
     * entry to model a name the registry has ALIASED onto a canon — which
     * is the only way two written names share a slot (0147).
     */
    aliases: Record<string, string> = {},
  ): BeliefPromotionService {
    const surreal = {
      withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>) => fn(db),
    } as unknown as SurrealService;
    const versions = {
      resolve: () => ({ version: 'scene-segmenter-v1' }),
    } as unknown as SceneVersionService;
    const config = { get: (_key: string, def?: string) => def } as unknown as ConfigService;
    const predicates = {
      canonicalize: async (_c: string, id: string) => ({
        kind: 'matched',
        canonicalId: aliases[id] ?? id,
      }),
    };
    return new BeliefPromotionService(surreal, config, versions, predicates as never);
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
      predicateId: 'location',
      value: 'Porto',
      priorValue: 'Lisbon',
      validFrom: '2026-08-18T19:00:00.000Z',
      sourceSceneIds: ['memory_episode:sb'],
      conversationIds: ['conv:b'],
      ...over,
    });

  /**
   * The leftover an earlier batch wrote under a different NAME in the
   * SAME slot — the registry had resolved `current_location` onto
   * `location` by the time that run happened, so the row carries the
   * canonical slot and a stale display name. Absorption is now this
   * exact test and nothing lexical: same slot, not the head.
   */
  const orphanRow = (over: Partial<FakeBeliefRow> = {}): FakeBeliefRow =>
    belief({
      id: 'semantic_belief:orphan1',
      field: 'current location',
      predicateId: 'location',
      ...over,
    });

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

  it('retires a second active row in the slot, into the head, which keeps its own value', async () => {
    const db = new FakeBeliefDb();
    db.rows = [canonicalRow(), orphanRow()];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.slotDuplicatesRetired).toBe(1);

    const orphan = db.rows.find((r) => r.id === 'semantic_belief:orphan1')!;
    expect(orphan.status).toBe('superseded');
    expect(orphan.value).toBe('Lisbon'); // value untouched — mark, never rewrite

    const canonical = db.rows.find((r) => r.id === 'semantic_belief:canon1')!;
    expect(canonical).toMatchObject({
      status: 'active',
      field: 'location',
      value: 'Porto', // the surviving row wins with its OWN value
    });
    // One active row in the slot, whatever name it was written under.
    expect(db.rows.filter((r) => r.status === 'active' && r.subject === 'Sasha')).toHaveLength(1);
  });

  it('donates priorValue to the head ONLY when the head records none', async () => {
    const db = new FakeBeliefDb();
    const head = canonicalRow();
    delete head.priorValue;
    db.rows = [head, orphanRow({ value: 'Lisbon' })];
    db.sceneHeads = [canonicalScene()];

    await makeRunService(db).run('co_test');
    expect(db.rows.find((r) => r.id === 'semantic_belief:canon1')!.priorValue).toBe('Lisbon');
  });

  it('no donation when the retired value equals the head value (a self-prior is meaningless)', async () => {
    const db = new FakeBeliefDb();
    const head = canonicalRow();
    delete head.priorValue;
    db.rows = [head, orphanRow({ value: 'Porto' })];
    db.sceneHeads = [canonicalScene()];

    await makeRunService(db).run('co_test');
    expect(db.rows.find((r) => r.id === 'semantic_belief:canon1')!.priorValue).toBeUndefined();
  });

  it('is idempotent — a second run finds one active row and retires nothing', async () => {
    const db = new FakeBeliefDb();
    db.rows = [canonicalRow(), orphanRow()];
    db.sceneHeads = [canonicalScene()];

    const first = await makeRunService(db).run('co_test');
    expect(first.slotDuplicatesRetired).toBe(1);
    const second = await makeRunService(db).run('co_test');
    expect(second.slotDuplicatesRetired).toBe(0);
    expect(db.rows.find((r) => r.id === 'semantic_belief:orphan1')!.status).toBe('superseded');
  });

  it('never reaches across a different subject or a different user', async () => {
    const db = new FakeBeliefDb();
    db.rows = [
      canonicalRow(),
      // Same slot, different subject — a different attribute instance.
      orphanRow({ id: 'semantic_belief:other_subj', subject: 'Dmitri' }),
      // Same slot and subject, different user — the #387 fence.
      orphanRow({ id: 'semantic_belief:other_user', userId: 'u2' }),
    ];
    db.sceneHeads = [canonicalScene()];

    const res = await makeRunService(db).run('co_test');
    expect(res.slotDuplicatesRetired).toBe(0);
    expect(db.rows.find((r) => r.id === 'semantic_belief:other_subj')!.status).toBe('active');
    expect(db.rows.find((r) => r.id === 'semantic_belief:other_user')!.status).toBe('active');
  });

  it('two names the registry keeps APART are two slots and never touch each other', async () => {
    // What the same-run fence used to guard, guarded now by construction:
    // parallel attributes have different slots, so neither is ever a
    // candidate for the other's sweep — there is nothing to fence.
    const db = new FakeBeliefDb();
    db.rows = [
      belief({
        id: 'semantic_belief:car1',
        subject: 'Mikhail',
        field: 'car',
        predicateId: 'car',
        value: 'BMW',
      }),
      belief({
        id: 'semantic_belief:own1',
        subject: 'Mikhail',
        field: 'car ownership',
        predicateId: 'car_ownership',
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
    expect(res.slotDuplicatesRetired).toBe(0);
    expect(db.active('car', 'Mikhail')).toBeDefined();
    expect(db.active('car ownership', 'Mikhail')).toBeDefined();
  });

  it('two names the registry MERGES land in one slot and one survives', async () => {
    // The live shape this whole change exists for: `deployment target`
    // and `deployment platform` held AWS ECS Fargate and Fly.io side by
    // side as two current settings. Aliased onto one predicate, they are
    // one slot, and the second row stops serving.
    const db = new FakeBeliefDb();
    db.rows = [
      belief({
        id: 'semantic_belief:dep1',
        subject: 'ledger-sync',
        field: 'deployment target',
        predicateId: 'deploy_target',
        value: 'AWS ECS Fargate',
        revision: 2,
      }),
      belief({
        id: 'semantic_belief:dep2',
        subject: 'ledger-sync',
        field: 'deployment platform',
        predicateId: 'deploy_target',
        value: 'Fly.io',
        revision: 1,
      }),
    ];
    db.sceneHeads = [
      scene({
        id: 'memory_episode:sd',
        conversationIds: ['conv:e'],
        occurredTo: '2026-08-20T10:00:00.000Z',
        stateDeltas: [
          { subject: 'ledger-sync', field: 'deployment target', from: '', to: 'AWS ECS Fargate' },
        ],
      }),
    ];

    const res = await makeRunService(db, { deployment_target: 'deploy_target' }).run('co_test');
    expect(res.slotDuplicatesRetired).toBe(1);
    expect(db.rows.find((r) => r.id === 'semantic_belief:dep2')!.status).toBe('superseded');
    const serving = db.rows.filter((r) => r.status === 'active' && r.subject === 'ledger-sync');
    expect(serving).toHaveLength(1);
    expect(serving[0]!.value).toBe('AWS ECS Fargate');
  });
  describe('two clocks + compare-and-set (audit 2026-09-06 F6, fake db)', () => {
    const at = (day: string) => `2026-${day}T00:00:00.000Z`;
    const evidence = (tail: string, day: string, value: string, from = ''): PromotableSceneHead =>
      scene({
        id: `memory_episode:${tail}`,
        conversationIds: [`conv:${tail}`],
        occurredTo: at(day),
        stateDeltas: [{ subject: 'alice', field: 'city', from, to: value }],
      });
    const headA = (over: Partial<FakeBeliefRow> = {}): FakeBeliefRow =>
      belief({
        id: 'semantic_belief:city1',
        subject: 'alice',
        field: 'city',
        value: 'A',
        validFrom: at('01-01'),
        sourceSceneIds: ['memory_episode:t1'],
        conversationIds: ['conv:t1'],
        ...over,
      });

    it('stale guard against the WATERMARK: a differing value dated between two confirmations is a skip', async () => {
      // The audit's repro judged against the head ALONE: A began Jan 1,
      // was confirmed Mar 1, and B dated Feb 1 arrives late.
      const db = new FakeBeliefDb();
      db.rows = [
        headA({
          latestEvidenceAt: at('03-01'),
          sourceSceneIds: ['memory_episode:t1', 'memory_episode:t3'],
          conversationIds: ['conv:t1', 'conv:t3'],
        }),
      ];
      db.sceneHeads = [evidence('t2', '02-01', 'B')];
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ skippedStale: 1, beliefsRevised: 0, beliefsCreated: 0 });
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0]).toMatchObject({ value: 'A', status: 'active', revision: 1 });
      expect(db.sql.some((s) => s.startsWith('BEGIN TRANSACTION'))).toBe(false);
    });

    it('a confirmation advances the watermark and leaves the beginning alone; a legacy row is stamped', async () => {
      const db = new FakeBeliefDb();
      db.rows = [headA()]; // pre-0137: no watermark at all
      db.sceneHeads = [evidence('t3', '03-01', 'A')];
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ beliefsCorroborated: 1, beliefsRevised: 0, beliefsRealigned: 0 });
      const head = db.active('city', 'alice')!;
      expect(head.validFrom).toBe(at('01-01'));
      expect(head.latestEvidenceAt).toEqual(new Date(at('03-01')));
      expect(head.sourceSceneIds).toEqual(['memory_episode:t1', 'memory_episode:t3']);
    });

    it('a targeted run folds the WHOLE chain: the late B realigns the beginning to the run after it', async () => {
      // Same world, but the run is targeted at the late conversation and
      // the chain read (the fake answers every scene query with the whole
      // world) shows A · B · A: the current A began in MARCH, displacing B.
      const db = new FakeBeliefDb();
      db.rows = [
        headA({
          latestEvidenceAt: at('03-01'),
          sourceSceneIds: ['memory_episode:t1', 'memory_episode:t3'],
          conversationIds: ['conv:t1', 'conv:t3'],
        }),
      ];
      db.sceneHeads = [
        evidence('t1', '01-01', 'A'),
        evidence('t2', '02-01', 'B'),
        evidence('t3', '03-01', 'A'),
      ];
      const res = await makeRunService(db).run('co_test', { conversationId: 'conv:t2' });
      expect(res).toMatchObject({
        beliefsRealigned: 1,
        beliefsRevised: 0,
        beliefsCreated: 0,
        skippedStale: 0,
      });
      const head = db.active('city', 'alice')!;
      expect(head).toMatchObject({ value: 'A', priorValue: 'B', revision: 1, status: 'active' });
      expect(head.validFrom).toEqual(new Date(at('03-01')));
      expect(db.rows).toHaveLength(1);
      // The chain was read with the affected users as the filter.
      expect(db.sql.some((s) => s.includes('userIds CONTAINSANY $users'))).toBe(true);
    });

    it('a head that moved under the run is not revised twice: the verdict is taken again against the head that now exists', async () => {
      const db = new FakeBeliefDb();
      db.rows = [headA({ latestEvidenceAt: at('01-01') })];
      db.sceneHeads = [evidence('t2', '02-01', 'B', 'A')];
      // Another writer's revise lands between this run's head read and
      // its transaction: the guarded stamp matches zero rows, the write
      // (INSERT included) is abandoned whole, and the retry judges the
      // candidate against the head that actually exists now — which
      // already says B, so this run only corroborates it.
      db.beforeTransaction = () => {
        db.beforeTransaction = undefined;
        db.rows[0]!.status = 'superseded';
        db.rows.push(
          belief({
            id: 'semantic_belief:rival2',
            subject: 'alice',
            field: 'city',
            value: 'B',
            priorValue: 'A',
            revision: 2,
            validFrom: at('02-01'),
            latestEvidenceAt: at('02-01'),
            sourceSceneIds: [],
            conversationIds: [],
          }),
        );
      };
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ beliefsRevised: 0, beliefsCreated: 0, skippedContended: 0 });
      expect(db.rows.filter((r) => r.status === 'active')).toHaveLength(1);
      expect(db.active('city', 'alice')).toMatchObject({ value: 'B', revision: 2 });
      expect(db.sql.filter((s) => s.startsWith('BEGIN TRANSACTION'))).toHaveLength(1);
    });

    it('a head that keeps moving is counted as contended after one retry, never written', async () => {
      const db = new FakeBeliefDb();
      db.rows = [headA({ latestEvidenceAt: at('01-01') })];
      db.sceneHeads = [evidence('t2', '02-01', 'B', 'A')];
      // The head's revision moves after every read — both attempts lose.
      db.beforeTransaction = () => {
        db.rows[0]!.revision += 1;
      };
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ skippedContended: 1, beliefsRevised: 0, beliefsCreated: 0 });
      expect(db.rows).toHaveLength(1);
      expect(db.sql.filter((s) => s.startsWith('BEGIN TRANSACTION'))).toHaveLength(2);
    });

    it('a corroboration between the read and the transaction stops the revise: the watermark is in the predicate', async () => {
      // The window is the awaited statement composition. Another run
      // confirms A into March while this run still believes the watermark
      // is January — its revise to B (February validity) must not land,
      // or A would be superseded with a validUntil BEFORE its own latest
      // evidence.
      const db = new FakeBeliefDb();
      db.rows = [headA({ latestEvidenceAt: at('01-01') })];
      db.sceneHeads = [evidence('t2', '02-01', 'B', 'A')];
      db.beforeTransaction = () => {
        db.beforeTransaction = undefined;
        db.rows[0]!.latestEvidenceAt = new Date(at('03-01'));
      };
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ beliefsRevised: 0, beliefsCreated: 0, skippedStale: 1 });
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0]).toMatchObject({ value: 'A', status: 'active', revision: 1 });
      expect(db.rows[0]!.validUntil).toBeUndefined();
    });

    it('the revise transaction carries the new row AND the guarded supersede stamp together', async () => {
      const db = new FakeBeliefDb();
      db.rows = [headA({ latestEvidenceAt: at('01-01') })];
      db.sceneHeads = [evidence('t2', '02-01', 'B', 'A')];
      const res = await makeRunService(db).run('co_test');
      expect(res).toMatchObject({ beliefsRevised: 1, skippedContended: 0 });
      const tx = db.sql.find((s) => s.startsWith('BEGIN TRANSACTION'))!;
      expect(tx).toContain('INSERT IGNORE INTO semantic_belief $rows');
      expect(tx).toContain(
        "WHERE status = 'active' AND revision = $headRevision " +
          'AND (latestEvidenceAt IS NONE OR latestEvidenceAt = $wm) RETURN AFTER',
      );
      expect(tx).toContain("THROW 'belief head moved'");
      expect(tx).toContain('COMMIT TRANSACTION');
      const [rev1, rev2] = [...db.rows].sort((a, b) => a.revision - b.revision);
      expect(rev1).toMatchObject({ status: 'superseded', supersededBy: rev2!.id });
      expect(rev2).toMatchObject({ value: 'B', priorValue: 'A', status: 'active', revision: 2 });
      expect(rev2!.validFrom).toEqual(new Date(at('02-01')));
      expect(rev2!.latestEvidenceAt).toEqual(new Date(at('02-01')));
    });
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
    const predicates = {
      canonicalize: async (_c: string, id: string) => ({ kind: 'matched', canonicalId: id }),
    };
    return new BeliefPromotionService(surreal, config, versions, predicates as never);
  }

  it('flag off ⇒ zero queries, zero version resolution, all-zero result', async () => {
    delete process.env.SCENES_BELIEF_PROMOTION;
    const result = await makeService().run('co_test');
    expect(result).toEqual({
      scenes: 0,
      eligibleScenes: 0,
      skippedMixedUser: 0,
      skippedLowValue: 0,
      skippedConflict: 0,
      fieldFolds: 0,
      slotDuplicatesRetired: 0,
      skippedFloor: 0,
      skippedStale: 0,
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
      beliefsRealigned: 0,
      skippedContended: 0,
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
