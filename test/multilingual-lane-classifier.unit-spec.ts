import {
  buildLaneCentroids,
  classifyLane,
  CLASSIFIER_LANES,
  LANE_EXEMPLARS,
  LANE_CLASSIFIER_MIN_COSINE,
  LANE_CLASSIFIER_MIN_MARGIN,
  type ClassifierLane,
  type LaneClassifierModel,
} from '../src/synthesize/multilingual-lane-classifier';
import { ALL_LANES, resolveRetrievalProfile, type LaneId } from '../src/search/retrieval-profile';

/**
 * Multilingual Tier 4 — the pure language-agnostic lane classifier
 * (MULTILINGUAL_LANE_ROUTING). Synthetic embeddings only: the pure decision
 * takes precomputed vectors, so abstain/classify/margin logic is tested
 * without an embedder. The off-path (byte-identical regex routing) is pinned
 * by the profile default + the genre-presets snapshot; here we prove the
 * decision itself is abstain-safe and never emits an inactive / non-routable
 * lane.
 */

/** Standard basis vector e_i in `dims` dimensions. */
const basis = (i: number, dims = 5): number[] => {
  const v = new Array<number>(dims).fill(0);
  v[i] = 1;
  return v;
};

/** Orthonormal 4-lane model in `dims`≥4 dims; lanes live in dims 0..3, so a
 *  query with weight in dim 4 can score arbitrarily low against all of them. */
const model = (dims = 5): LaneClassifierModel => [
  { lane: 'temporal', centroid: basis(0, dims), sampleCount: 3 },
  { lane: 'enumeration', centroid: basis(1, dims), sampleCount: 3 },
  { lane: 'preference', centroid: basis(2, dims), sampleCount: 3 },
  { lane: 'summary', centroid: basis(3, dims), sampleCount: 3 },
];

const ALL = new Set<LaneId>(ALL_LANES);
const classify = (q: number[], active: ReadonlySet<LaneId> = ALL, m = model()) =>
  classifyLane({
    model: m,
    queryEmbedding: q,
    activeLanes: active,
    minCosine: LANE_CLASSIFIER_MIN_COSINE,
    minMargin: LANE_CLASSIFIER_MIN_MARGIN,
  });

describe('CLASSIFIER_LANES — only query-routable lanes', () => {
  it('excludes the evidence-conditional lanes (never routed from query text)', () => {
    for (const forbidden of ['contradiction', 'recency', 'instruction', 'strategy'] as const) {
      expect(CLASSIFIER_LANES).not.toContain(forbidden);
    }
  });
  it('every classifier lane is a real LaneId with exemplars in many languages', () => {
    for (const lane of CLASSIFIER_LANES) {
      expect(ALL_LANES).toContain(lane);
      // A handful of paraphrases across languages — enough for a mean centroid.
      expect(LANE_EXEMPLARS[lane].length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('buildLaneCentroids', () => {
  it('averages exemplar embeddings per lane and drops empty lanes', () => {
    const by = new Map<ClassifierLane, number[][]>([
      [
        'temporal',
        [
          [2, 0, 0],
          [0, 2, 0],
        ],
      ],
      ['enumeration', []], // no usable exemplars → dropped
    ]);
    const built = buildLaneCentroids(by);
    expect(built.map((c) => c.lane)).toEqual(['temporal']);
    expect(built[0]!.centroid).toEqual([1, 1, 0]); // componentwise mean
    expect(built[0]!.sampleCount).toBe(2);
  });
  it('never averages across mismatched dimensions', () => {
    const by = new Map<ClassifierLane, number[][]>([
      [
        'temporal',
        [
          [1, 0],
          [9, 9, 9], // wrong dim — skipped
        ],
      ],
    ]);
    const built = buildLaneCentroids(by);
    expect(built[0]!.centroid).toEqual([1, 0]);
    expect(built[0]!.sampleCount).toBe(1);
  });
});

describe('classifyLane — confident match', () => {
  it('routes a query nearest one centroid to that lane', () => {
    const d = classify(basis(0)); // pure temporal direction
    expect(d.lane).toBe('temporal');
    expect(d.outcome).toBe('classified');
    expect(d.ranked[0]!.lane).toBe('temporal');
  });
  it('routes to the second lane when it dominates', () => {
    expect(classify(basis(2)).lane).toBe('preference');
  });
});

describe('classifyLane — abstain outcomes (abstain-safe)', () => {
  it('abstains (low confidence) below the cosine floor', () => {
    // Mostly in dim 4 where no centroid lives → best cosine ≈ 0.1.
    const d = classify([0.1, 0, 0, 0, 1]);
    expect(d.lane).toBeNull();
    expect(d.outcome).toBe('abstain_low_confidence');
  });
  it('abstains (ambiguous) when the top two are within the margin', () => {
    const d = classify([1, 1, 0, 0, 0]); // equidistant temporal/enumeration
    expect(d.lane).toBeNull();
    expect(d.outcome).toBe('abstain_ambiguous');
  });
  it('abstains (no model) on an empty model', () => {
    expect(classify(basis(0), ALL, []).outcome).toBe('abstain_no_model');
  });
  it('abstains (no model) on a dimension mismatch', () => {
    const d = classify([1, 0, 0], ALL, model(5)); // query dim 3 vs centroid dim 5
    expect(d.outcome).toBe('abstain_no_model');
    expect(d.lane).toBeNull();
  });
  it('abstains on an empty query embedding', () => {
    expect(classify([]).outcome).toBe('abstain_no_model');
  });
});

describe('classifyLane — respects the active lane set', () => {
  it('never emits a lane outside activeLanes', () => {
    // temporal is the nearest but not active; the only active routable lane
    // (enumeration) is orthogonal ⇒ below the floor ⇒ abstain, not a wrong route.
    const active = new Set<LaneId>(['enumeration', 'contradiction']);
    const d = classify(basis(0), active);
    expect(d.lane).not.toBe('temporal');
    expect(d.lane).toBeNull();
    expect(d.ranked.every((r) => active.has(r.lane))).toBe(true);
  });
  it('routes to the nearest ACTIVE lane when it clears the floor', () => {
    const active = new Set<LaneId>(['enumeration', 'summary']);
    expect(classify(basis(1), active).lane).toBe('enumeration');
  });
});

describe('MULTILINGUAL_LANE_ROUTING → RetrievalProfile.multilingualLaneRouting', () => {
  it('defaults off and round-trips through the profile resolver', () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).multilingualLaneRouting).toBe(false);
    expect(
      resolveRetrievalProfile({
        MULTILINGUAL_LANE_ROUTING: '1',
      } as NodeJS.ProcessEnv).multilingualLaneRouting,
    ).toBe(true);
    expect(
      resolveRetrievalProfile({
        MULTILINGUAL_LANE_ROUTING: '0',
      } as NodeJS.ProcessEnv).multilingualLaneRouting,
    ).toBe(false);
  });
});
