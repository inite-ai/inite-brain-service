import { ndcgAtK } from './eval/metrics/ndcg';
import type { QueryResult } from './eval/types';

const q = (rank: number, temporal = false): QueryResult => ({
  query: 'q',
  expectedTopEntityRef: 'a.b',
  rankOfExpected: rank,
  topEntityRef: null,
  factPredicateMatched: null,
  piiGatedCorrectly: null,
  temporal,
});

describe('ndcgAtK', () => {
  it('returns null on empty input', () => {
    expect(ndcgAtK([], 10)).toBeNull();
  });

  it('rank=1 → score=1.0 (ideal)', () => {
    expect(ndcgAtK([q(1)], 10)).toBeCloseTo(1.0, 6);
  });

  it('rank=2 → score=1/log2(3) ≈ 0.6309', () => {
    expect(ndcgAtK([q(2)], 10)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it('rank=3 → score=1/log2(4) = 0.5', () => {
    expect(ndcgAtK([q(3)], 10)).toBeCloseTo(0.5, 6);
  });

  it('rank=0 (miss) → score=0', () => {
    expect(ndcgAtK([q(0)], 10)).toBe(0);
  });

  it('rank > k → score=0 (out of cutoff)', () => {
    expect(ndcgAtK([q(15)], 10)).toBe(0);
  });

  it('averages across queries', () => {
    // Two queries, ranks 1 and 3. Mean = (1.0 + 0.5) / 2 = 0.75.
    expect(ndcgAtK([q(1), q(3)], 10)).toBeCloseTo(0.75, 6);
  });

  it('miss in middle drags down the mean', () => {
    // Three queries, ranks 1, 0, 1. Mean = (1 + 0 + 1) / 3 = 0.667.
    expect(ndcgAtK([q(1), q(0), q(1)], 10)).toBeCloseTo(2 / 3, 6);
  });
});
