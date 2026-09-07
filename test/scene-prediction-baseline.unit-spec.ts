/**
 * Unit tests for the scene PREDICTION BASELINE (SCENES_PREDICTION_BASELINE):
 * the bounded ACTIVE-belief read, subject extraction and caps, the #387
 * cross-user fence, the prompt block renderer, and the deterministic
 * prediction-error scorer matrix — including the load-bearing negative:
 * an unknown baseline yields UNDEFINED contradiction, never a confident 0.
 * Pure functions plus one scripted db double. No Nest, no network, no
 * paid calls.
 */
import {
  assembleSceneBaseline,
  baselineRefPayload,
  loadActiveBeliefBaseline,
  normalizeLexical,
  renderBaselineBlock,
  sceneBaseline,
  sceneSelfSubjects,
  scorePredictionError,
  BASELINE_MAX_BELIEFS,
  BASELINE_MAX_SUBJECTS,
  BASELINE_QUERY_LIMIT,
  SCENE_BASELINE_VERSION,
  SCENE_PREDICTION_SCORER_VERSION,
  type BaselineBelief,
  type BaselineDb,
} from '../src/admin/scene-prediction-baseline';
import type { SceneTurnRow } from '../src/admin/scene-segmentation';

const belief = (
  subject: string,
  field: string,
  value: string,
  revision = 1,
  id = `semantic_belief:${subject}_${field}`.replace(/\s+/g, '_'),
): BaselineBelief => ({ id, subject, field, value, revision });

const turn = (speaker: string, text: string): SceneTurnRow => ({
  id: `episode:${speaker}_${text.slice(0, 4)}`,
  speaker,
  text,
  occurredAt: '2026-02-01T10:00:00.000Z',
});

describe('normalizeLexical', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeLexical('  Car   Ownership! ')).toBe('car ownership');
    expect(normalizeLexical('Mika’s—Car')).toBe('mika s car');
    expect(normalizeLexical('!!!')).toBe('');
  });

  it('keeps non-ASCII letters (the substrate is multilingual)', () => {
    expect(normalizeLexical('Пользователь')).toBe('пользователь');
  });
});

describe('sceneSelfSubjects', () => {
  it('includes the scene userId and non-assistant speakers, never the assistant', () => {
    const self = sceneSelfSubjects('Mika', [
      turn('mika', 'I booked the flight.'),
      turn('proj__assistant', 'Noted.'),
    ]);
    expect(self.has('mika')).toBe(true);
    expect(self.has('proj assistant')).toBe(false);
    // Documented markers ride along in both languages.
    expect(self.has('user')).toBe(true);
    expect(self.has('я')).toBe(true);
  });

  it('tolerates a fenced-out (null) userId', () => {
    const self = sceneSelfSubjects(null, [turn('ana', 'hi')]);
    expect(self.has('ana')).toBe(true);
  });
});

describe('assembleSceneBaseline', () => {
  const transcript = 'mika: I moved to Lisbon last week and Ana came along.';

  it('keeps beliefs the scene is about and drops the rest', () => {
    const out = assembleSceneBaseline(
      [
        belief('mika', 'city', 'Riga'),
        belief('ana', 'city', 'Riga'),
        belief('bob', 'city', 'Riga'),
      ],
      transcript,
      sceneSelfSubjects('mika', []),
    );
    expect(out.map((b) => b.subject)).toEqual(['ana', 'mika']);
  });

  it('matches whole phrases only — never a word interior', () => {
    const out = assembleSceneBaseline(
      [belief('ana', 'fruit', 'apple')],
      'mika: I ate a banana today.',
      sceneSelfSubjects(null, []),
    );
    expect(out).toEqual([]);
  });

  it('keeps a self-subject belief even when the transcript never names it', () => {
    const out = assembleSceneBaseline(
      [belief('mika', 'job', 'baker')],
      'the weather is fine',
      sceneSelfSubjects('mika', []),
    );
    expect(out).toHaveLength(1);
  });

  it('caps beliefs and subjects, deterministically and repeatably', () => {
    const many: BaselineBelief[] = [];
    for (let i = 0; i < BASELINE_MAX_BELIEFS + 10; i++) {
      many.push(belief('mika', `field${String(i).padStart(3, '0')}`, `v${i}`));
    }
    const out = assembleSceneBaseline(many, 'x', sceneSelfSubjects('mika', []));
    expect(out).toHaveLength(BASELINE_MAX_BELIEFS);
    // Total order ⇒ the same slice every time, so enrichment is reproducible.
    expect(assembleSceneBaseline([...many].reverse(), 'x', sceneSelfSubjects('mika', []))).toEqual(
      out,
    );
  });

  it('caps distinct subjects', () => {
    const subjects: BaselineBelief[] = [];
    const names: string[] = [];
    for (let i = 0; i < BASELINE_MAX_SUBJECTS + 5; i++) {
      const name = `subj${String(i).padStart(3, '0')}`;
      names.push(name);
      subjects.push(belief(name, 'f', 'v'));
    }
    const out = assembleSceneBaseline(subjects, names.join(' '), sceneSelfSubjects(null, []));
    expect(new Set(out.map((b) => b.subject)).size).toBe(BASELINE_MAX_SUBJECTS);
  });
});

describe('sceneBaseline (#387 cross-user fence)', () => {
  const beliefsByUser = new Map<string, BaselineBelief[]>([
    ['u1', [belief('mika', 'city', 'Riga')]],
    ['u2', [belief('mika', 'city', 'Berlin')]],
  ]);
  const transcript = 'mika: I moved to Lisbon.';
  const turns = [turn('mika', 'I moved to Lisbon.')];

  it('scores a scene against ITS OWN user only', () => {
    const out = sceneBaseline({
      scene: { id: 'memory_episode:s1', userId: 'u1', userIds: ['u1'] },
      turns,
      transcript,
      beliefsByUser,
    });
    expect(out.userId).toBe('u1');
    expect(out.beliefs.map((b) => b.value)).toEqual(['Riga']);
    // The other tenant-user's belief never appears.
    expect(out.beliefs.some((b) => b.value === 'Berlin')).toBe(false);
  });

  it.each([
    ['mixed-user', { userId: 'u1', userIds: ['u1', 'u2'] }],
    ['tenant-global', { userId: undefined, userIds: [] }],
    ['legacy (no userIds)', { userId: 'u1', userIds: undefined }],
    ['disagreeing stamps', { userId: 'u2', userIds: ['u1'] }],
  ])('gives %s scenes NO baseline at all', (_label, scope) => {
    const out = sceneBaseline({
      scene: { id: 'memory_episode:s1', ...scope },
      turns,
      transcript,
      beliefsByUser,
    });
    expect(out.userId).toBeNull();
    expect(out.beliefs).toEqual([]);
  });
});

describe('loadActiveBeliefBaseline', () => {
  const rows = [
    {
      id: 'semantic_belief:a',
      userId: 'u1',
      subject: 'mika',
      field: 'city',
      value: 'Riga',
      revision: 2,
    },
    {
      id: 'semantic_belief:b',
      userId: 'u2',
      subject: 'ana',
      field: 'city',
      value: 'Oslo',
      revision: 1,
    },
    { id: 'semantic_belief:c', userId: '', subject: 'x', field: 'y', value: 'z', revision: 1 },
    { id: 'semantic_belief:d', userId: 'u1', subject: '  ', field: 'y', value: 'z', revision: 1 },
  ];

  interface Call {
    sql: string;
    params: Record<string, unknown> | undefined;
  }

  function db(): { db: BaselineDb; calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      db: {
        query: (async (sql: string, params?: Record<string, unknown>) => {
          calls.push({ sql, params });
          return [rows];
        }) as BaselineDb['query'],
      },
    };
  }

  it('makes ZERO queries for an empty user set', async () => {
    const { db: d, calls } = db();
    expect(await loadActiveBeliefBaseline(d, [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it('reads only ACTIVE rows of the given users, bounded, and buckets them', async () => {
    const { db: d, calls } = db();
    const out = await loadActiveBeliefBaseline(d, ['u1', 'u2']);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('userId INSIDE $userIds');
    expect(sql).toContain('LIMIT $cap');
    // A plain SELECT: reads never trip the 3.2.4 DELETE/UPDATE-WHERE trap.
    expect(sql.trim().startsWith('SELECT')).toBe(true);
    expect(params!.userIds).toEqual(['u1', 'u2']);
    expect(params!.cap).toBe(BASELINE_QUERY_LIMIT);
    expect(out.get('u1')).toEqual([
      { id: 'semantic_belief:a', subject: 'mika', field: 'city', value: 'Riga', revision: 2 },
    ]);
    expect(out.get('u2')).toHaveLength(1);
    // Rows with a blank userId or blank key column are dropped, not kept
    // under an empty key where they could leak into a scene's baseline.
    expect(out.has('')).toBe(false);
  });
});

describe('renderBaselineBlock', () => {
  it('renders an explicit empty marker rather than nothing', () => {
    const block = renderBaselineBlock([]);
    expect(block).toContain('Current model of the world');
    expect(block).toContain('nothing is known');
  });

  it('renders one line per belief with its revision', () => {
    const block = renderBaselineBlock([belief('mika', 'city', 'Riga', 3)]);
    expect(block).toContain('- mika | city = Riga (revision 3)');
  });
});

describe('baselineRefPayload', () => {
  it('is the {beliefs, stampedAt, baselineVersion} snapshot', () => {
    const payload = baselineRefPayload([belief('mika', 'city', 'Riga')]);
    expect(payload.baselineVersion).toBe(SCENE_BASELINE_VERSION);
    expect(typeof payload.stampedAt).toBe('string');
    expect(payload.beliefs).toEqual([
      {
        id: 'semantic_belief:mika_city',
        subject: 'mika',
        field: 'city',
        value: 'Riga',
        revision: 1,
      },
    ]);
  });
});

describe('scorePredictionError (deterministic, no model call)', () => {
  const selfSubjects = sceneSelfSubjects('mika', []);
  const delta = (subject: string, field: string, to: string, from = '') => ({
    subject,
    field,
    from,
    to,
  });

  it('is stamped by its own scorer version', () => {
    expect(SCENE_PREDICTION_SCORER_VERSION).toBe('scene-scorer-v1');
  });

  it('scores an AGREEING delta as no contradiction', () => {
    const out = scorePredictionError({
      baseline: [belief('mika', 'city', 'Lisbon')],
      stateDeltas: [delta('mika', 'city', 'Lisbon')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.contradiction).toBe(0);
  });

  it('scores a DISAGREEING delta as full contradiction', () => {
    const out = scorePredictionError({
      baseline: [belief('mika', 'city', 'Riga')],
      stateDeltas: [delta('mika', 'city', 'Lisbon')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.contradiction).toBe(1);
  });

  it('is the FRACTION of matched deltas that disagree', () => {
    const out = scorePredictionError({
      baseline: [belief('mika', 'city', 'Riga'), belief('mika', 'job', 'baker')],
      stateDeltas: [delta('mika', 'city', 'Lisbon'), delta('mika', 'job', 'baker')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.contradiction).toBe(0.5);
  });

  it('compares values string-NORMALIZED (case and punctuation are not disagreement)', () => {
    const out = scorePredictionError({
      baseline: [belief('Mika', 'city', 'Lisbon')],
      stateDeltas: [delta('mika', 'city', ' lisbon! ')],
      memberTurnCount: 2,
      selfSubjects,
    });
    expect(out.contradiction).toBe(0);
  });

  it('matches a re-coined field through the belief layer’s own fold rule', () => {
    const out = scorePredictionError({
      baseline: [belief('mika', 'car', 'Volvo')],
      stateDeltas: [delta('mika', 'car ownership', 'Saab')],
      memberTurnCount: 2,
      selfSubjects,
    });
    expect(out.contradiction).toBe(1);
  });

  it('refuses to measure an AMBIGUOUS field match (fail-closed)', () => {
    // Both stored names fold onto the incoming 'car'; fieldsFold is not
    // transitive, so measuring against either would be a coin flip.
    const out = scorePredictionError({
      baseline: [belief('mika', 'car ownership', 'Volvo'), belief('mika', 'car status', 'sold')],
      stateDeltas: [delta('mika', 'car', 'Saab')],
      memberTurnCount: 2,
      selfSubjects,
    });
    expect(out.contradiction).toBeUndefined();
  });

  it('leaves contradiction UNDEFINED with no beliefs — an unknown baseline is not a confident zero', () => {
    const out = scorePredictionError({
      baseline: [],
      stateDeltas: [delta('mika', 'city', 'Lisbon')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.contradiction).toBeUndefined();
    expect(out).not.toHaveProperty('contradiction');
    // The baseline-free dimensions are still measured.
    expect(out.stateChange).toBeGreaterThan(0);
    expect(out.identity).toBe(1);
  });

  it('leaves contradiction UNDEFINED when no belief matches the delta subject', () => {
    const out = scorePredictionError({
      baseline: [belief('ana', 'city', 'Oslo')],
      stateDeltas: [delta('mika', 'city', 'Lisbon')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.contradiction).toBeUndefined();
  });

  it('measures NOTHING without deltas or turns', () => {
    expect(
      scorePredictionError({
        baseline: [belief('mika', 'city', 'Riga')],
        stateDeltas: [],
        memberTurnCount: 4,
        selfSubjects,
      }),
    ).toEqual({});
    expect(
      scorePredictionError({
        baseline: [],
        stateDeltas: [delta('mika', 'city', 'Lisbon')],
        memberTurnCount: 0,
        selfSubjects,
      }),
    ).toEqual({});
  });

  it('saturates stateChange at one delta per two turns', () => {
    const dense = scorePredictionError({
      baseline: [],
      stateDeltas: [delta('a', 'f', 'v'), delta('b', 'f', 'v'), delta('c', 'f', 'v')],
      memberTurnCount: 3,
      selfSubjects,
    });
    expect(dense.stateChange).toBe(1);
    const sparse = scorePredictionError({
      baseline: [],
      stateDeltas: [delta('a', 'f', 'v')],
      memberTurnCount: 8,
      selfSubjects,
    });
    expect(sparse.stateChange).toBeCloseTo(0.25);
  });

  it('scores identity as the share of deltas about the speaker themselves', () => {
    const out = scorePredictionError({
      baseline: [],
      stateDeltas: [delta('mika', 'city', 'Lisbon'), delta('acme corp', 'ceo', 'ana')],
      memberTurnCount: 4,
      selfSubjects,
    });
    expect(out.identity).toBe(0.5);
  });
});
