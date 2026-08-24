import { collectFactWindow, remapWindowScores } from '../src/search/internals/fact-rerank';
import { selectFactCentric } from '../src/search/internals/fact-centric';
import type { EntityBucket } from '../src/search/internals/types';

/**
 * Fact-level cross-encoder rescoring (July A3): the fact-centric cut
 * slices the flat pool purely by fused score, so a near-duplicate with
 * better lexical luck outranks the gold fact. These specs pin the two
 * pure halves — window collection and the rank-preserving score remap —
 * plus the end-to-end property that a remap changes WHICH facts survive
 * the budget cut without moving the window/tail boundary.
 */
function bucket(id: string, scores: number[]): EntityBucket {
  return {
    entityId: id,
    rankScore: Math.max(...scores),
    bestScore: Math.max(...scores),
    facts: scores.map((score, i) => ({
      row: { id: `${id}:f${i}`, predicate: 'p', object: `obj-${id}-${i}` },
      score,
    })),
  } as unknown as EntityBucket;
}

describe('collectFactWindow', () => {
  it('flattens across buckets and keeps the top-N by score, descending', () => {
    const rows = collectFactWindow([bucket('a', [0.9, 0.2]), bucket('b', [0.7, 0.5])], 3);
    expect(rows.map((r) => r.row.score)).toEqual([0.9, 0.7, 0.5]);
    expect(rows[0]!.bucket.entityId).toBe('a');
    expect(rows[1]!.bucket.entityId).toBe('b');
  });

  it('window larger than the pool returns the whole pool', () => {
    expect(collectFactWindow([bucket('a', [0.4, 0.3])], 10)).toHaveLength(2);
  });

  it('non-positive window returns empty', () => {
    expect(collectFactWindow([bucket('a', [0.4])], 0)).toHaveLength(0);
  });
});

describe('remapWindowScores', () => {
  it('reassigns the ORIGINAL score set along the permutation order', () => {
    const b = bucket('a', [0.9, 0.7, 0.5]);
    const rows = collectFactWindow([b], 3);
    // CE says: former #2 (0.5) is most relevant, then #0, then #1.
    expect(remapWindowScores(rows, [2, 0, 1])).toBe(true);
    expect(b.facts.map((f) => f.score)).toEqual([0.7, 0.5, 0.9]);
    // Score VALUE set is preserved exactly.
    expect([...b.facts.map((f) => f.score)].sort()).toEqual([0.5, 0.7, 0.9]);
  });

  it('identity permutation is a byte-identical no-op', () => {
    const b = bucket('a', [0.9, 0.7, 0.5]);
    const rows = collectFactWindow([b], 3);
    remapWindowScores(rows, [0, 1, 2]);
    expect(b.facts.map((f) => f.score)).toEqual([0.9, 0.7, 0.5]);
  });

  it('rejects malformed permutations (length, range, duplicates)', () => {
    const b = bucket('a', [0.9, 0.7]);
    const rows = collectFactWindow([b], 2);
    expect(remapWindowScores(rows, [0])).toBe(false);
    expect(remapWindowScores(rows, [0, 2])).toBe(false);
    expect(remapWindowScores(rows, [1, 1])).toBe(false);
    expect(b.facts.map((f) => f.score)).toEqual([0.9, 0.7]);
  });

  it('keeps the top-1 score value stable for downstream gates', () => {
    const b = bucket('a', [0.9, 0.7, 0.5]);
    const rows = collectFactWindow([b], 3);
    remapWindowScores(rows, [1, 2, 0]);
    expect(Math.max(...b.facts.map((f) => f.score))).toBe(0.9);
  });
});

describe('fact rerank feeding the fact-centric cut', () => {
  it('a CE promotion pulls a below-cut fact into the budget window', () => {
    // Pool of 4, budget 2: fused order keeps a0 (0.9) + a1 (0.8).
    const a = bucket('a', [0.9, 0.8]);
    const c = bucket('c', [0.7, 0.6]);
    const rows = collectFactWindow([a, c], 4);
    // CE ranks c's facts above a1: [a0, c0, c1, a1].
    remapWindowScores(rows, [0, 2, 3, 1]);
    const out = selectFactCentric([a, c], 2, {});
    const kept = out.flatMap((b) => b.facts.map((f) => String(f.row.id)));
    expect(kept).toHaveLength(2);
    expect(kept).toContain('a:f0');
    expect(kept).toContain('c:f0');
  });

  it('facts outside the window are untouched (boundary cannot move)', () => {
    const a = bucket('a', [0.9, 0.8, 0.3]);
    const rows = collectFactWindow([a], 2);
    remapWindowScores(rows, [1, 0]);
    // Tail fact keeps its score; window min (0.8) still above it.
    expect(a.facts[2]!.score).toBe(0.3);
    expect(Math.min(...a.facts.slice(0, 2).map((f) => f.score))).toBe(0.8);
  });
});
