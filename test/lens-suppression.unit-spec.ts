/**
 * Unit spec — fovea lens-suppression governor (Optics §4.3 pure module).
 *
 * Covers cosine similarity (bounds + degenerate cases), the usable-model
 * predicate (empty / bootstrap → not usable), and the subtractive decision:
 *   - class present + cosine ≥ floor → a strictly-reduced set (suppressed)
 *   - below floor → unchanged (low_confidence)
 *   - a match that would empty the set → the ORIGINAL set (floor_kept)
 *   - a disjoint suppress set → unchanged (no_op)
 *   - the SUBTRACTIVE INVARIANT: output ⊆ input, never a new lane, never
 *     reordered; and BYTE-IDENTICAL: every non-suppressed outcome returns the
 *     SAME set reference it was given.
 */
import type { LaneId } from '../src/search/retrieval-profile';
import {
  decideSuppression,
  isUsableModel,
  toLaneId,
  type LensSuppressionModel,
} from '../src/synthesize/lens-suppression';

const lanes = (...ids: LaneId[]): ReadonlySet<LaneId> => new Set<LaneId>(ids);

describe('toLaneId', () => {
  it('accepts valid LaneIds and drops everything else', () => {
    expect(toLaneId('instruction')).toBe('instruction');
    expect(toLaneId('strategy')).toBe('strategy');
    expect(toLaneId('not_a_lane')).toBeNull();
    expect(toLaneId(42)).toBeNull();
    expect(toLaneId(undefined)).toBeNull();
  });
});

describe('isUsableModel', () => {
  it('is false for an empty model (nothing persisted)', () => {
    expect(isUsableModel([])).toBe(false);
  });

  it('is false for a bootstrap model (all sampleCount 0 or centroid-less)', () => {
    expect(
      isUsableModel([
        { classId: 'default', centroid: [0.1, 0.2], suppressLanes: [], sampleCount: 0 },
      ]),
    ).toBe(false);
    expect(
      isUsableModel([
        { classId: 'default', centroid: [], suppressLanes: ['instruction'], sampleCount: 99 },
      ]),
    ).toBe(false);
  });

  it('is true once one class is fit from real samples with a centroid', () => {
    expect(
      isUsableModel([
        {
          classId: 'default',
          centroid: [0.1, 0.2],
          suppressLanes: ['instruction'],
          sampleCount: 5,
        },
      ]),
    ).toBe(true);
  });
});

describe('decideSuppression', () => {
  const model: LensSuppressionModel = [
    // Matches [1,0,0] with cosine 1; suppresses the instruction + strategy lanes.
    {
      classId: 'trap',
      centroid: [1, 0, 0],
      suppressLanes: ['instruction', 'strategy'],
      sampleCount: 100,
    },
    // Orthogonal to [1,0,0] (cosine 0); a decoy class.
    { classId: 'other', centroid: [0, 1, 0], suppressLanes: ['temporal'], sampleCount: 100 },
  ];

  it('no usable model → unchanged, same reference (no_model)', () => {
    const active = lanes('instruction', 'strategy', 'temporal');
    const d = decideSuppression({
      model: [],
      queryEmbedding: [1, 0, 0],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('no_model');
    expect(d.effectiveLanes).toBe(active); // SAME reference — byte-identical
    expect(d.removed).toEqual([]);
  });

  it('class present + cosine ≥ floor → strictly reduced set (suppressed)', () => {
    const active = lanes('instruction', 'strategy', 'temporal');
    const d = decideSuppression({
      model,
      queryEmbedding: [1, 0, 0],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('suppressed');
    expect(d.classId).toBe('trap');
    expect(d.cosine).toBeCloseTo(1, 10);
    expect([...d.effectiveLanes].sort()).toEqual(['temporal']);
    expect(d.removed.sort()).toEqual(['instruction', 'strategy']);
    // Subtractive: a strict, non-empty subset of the input.
    expect(d.effectiveLanes.size).toBeLessThan(active.size);
    expect(d.effectiveLanes.size).toBeGreaterThan(0);
    for (const l of d.effectiveLanes) expect(active.has(l)).toBe(true);
  });

  it('below the cosine floor → unchanged, same reference (low_confidence)', () => {
    const active = lanes('instruction', 'strategy', 'temporal');
    // Query orthogonal to the trap centroid: best cosine is 0 (the decoy),
    // below the 0.5 floor → uncertain → today's behaviour.
    const d = decideSuppression({
      model,
      queryEmbedding: [0, 0, 1],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('low_confidence');
    expect(d.effectiveLanes).toBe(active); // SAME reference — byte-identical
    expect(d.removed).toEqual([]);
  });

  it('a match that would empty the active set → the ORIGINAL set kept (floor_kept)', () => {
    const active = lanes('instruction', 'strategy');
    const d = decideSuppression({
      model,
      queryEmbedding: [1, 0, 0],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('floor_kept');
    expect(d.effectiveLanes).toBe(active); // never emptied — same reference
    expect(d.removed.sort()).toEqual(['instruction', 'strategy']);
  });

  it('a disjoint suppress set → unchanged, same reference (no_op)', () => {
    const active = lanes('temporal'); // trap suppresses instruction+strategy — disjoint
    const d = decideSuppression({
      model,
      queryEmbedding: [1, 0, 0],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('no_op');
    expect(d.effectiveLanes).toBe(active);
    expect(d.removed).toEqual([]);
  });

  it('a centroid whose dimension differs from the query is never a match', () => {
    const active = lanes('instruction', 'strategy', 'temporal');
    // Query has 4 dims; every model centroid has 3 → all skipped → uncertain.
    const d = decideSuppression({
      model,
      queryEmbedding: [1, 0, 0, 0],
      activeLanes: active,
      minCosine: 0.5,
    });
    expect(d.outcome).toBe('low_confidence');
    expect(d.effectiveLanes).toBe(active);
    expect(d.removed).toEqual([]);
  });

  it('SUBTRACTIVE INVARIANT: output ⊆ input and never a new lane, across cases', () => {
    const active = lanes('instruction', 'strategy', 'temporal', 'preference');
    const cases = [
      { queryEmbedding: [1, 0, 0], minCosine: 0.5 }, // suppress
      { queryEmbedding: [0, 0, 1], minCosine: 0.5 }, // low_confidence
      { queryEmbedding: [1, 0, 0], minCosine: 0.999 }, // just-below → low_confidence
      { queryEmbedding: [0, 1, 0], minCosine: 0.5 }, // 'other' → suppresses temporal
    ];
    for (const c of cases) {
      const d = decideSuppression({ model, activeLanes: active, ...c });
      // ⊆ input, never larger, never a lane the input lacked.
      expect(d.effectiveLanes.size).toBeLessThanOrEqual(active.size);
      for (const l of d.effectiveLanes) expect(active.has(l)).toBe(true);
      // Non-suppressed outcomes preserve the exact input reference.
      if (d.outcome !== 'suppressed') expect(d.effectiveLanes).toBe(active);
    }
  });
});
