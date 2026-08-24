import {
  recallAtKRanked,
  ndcgAtKRanked,
  aggregateRecallAtK,
  aggregateNdcgAtK,
} from './eval/metrics/cross-lingual-retrieval';
import type { RetrievalQuery } from './eval/metrics/cross-lingual-retrieval';

const ranked = ['a', 'b', 'c', 'd'];

describe('recallAtKRanked', () => {
  it('gold at rank 1 → 1 for any k ≥ 1', () => {
    expect(recallAtKRanked(ranked, 'a', 1)).toBe(1);
    expect(recallAtKRanked(ranked, 'a', 3)).toBe(1);
  });

  it('gold at rank 3 → 0 at k=1, 1 at k=3', () => {
    expect(recallAtKRanked(ranked, 'c', 1)).toBe(0);
    expect(recallAtKRanked(ranked, 'c', 3)).toBe(1);
  });

  it('gold absent → 0', () => {
    expect(recallAtKRanked(ranked, 'zzz', 4)).toBe(0);
  });

  it('empty ranking → 0', () => {
    expect(recallAtKRanked([], 'a', 3)).toBe(0);
  });
});

describe('ndcgAtKRanked', () => {
  it('rank 1 → 1.0', () => {
    expect(ndcgAtKRanked(ranked, 'a', 10)).toBeCloseTo(1.0, 6);
  });

  it('rank 2 → 1/log2(3)', () => {
    expect(ndcgAtKRanked(ranked, 'b', 10)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it('rank 3 → 0.5', () => {
    expect(ndcgAtKRanked(ranked, 'c', 10)).toBeCloseTo(0.5, 6);
  });

  it('miss → 0', () => {
    expect(ndcgAtKRanked(ranked, 'zzz', 10)).toBe(0);
  });

  it('rank beyond k → 0', () => {
    expect(ndcgAtKRanked(ranked, 'd', 2)).toBe(0);
  });
});

describe('aggregateRecallAtK — mono/cross partition', () => {
  const queries: RetrievalQuery[] = [
    { ranked: ['x', 'a', 'b'], goldRef: 'x', direction: 'mono' }, // rank1
    { ranked: ['a', 'x', 'b'], goldRef: 'x', direction: 'cross' }, // rank2
    { ranked: ['a', 'b', 'c'], goldRef: 'x', direction: 'cross' }, // miss
  ];

  it('overall recall@1 = 1/3', () => {
    expect(aggregateRecallAtK(queries, 1).overall).toBeCloseTo(1 / 3, 6);
  });

  it('mono recall@1 = 1.0, cross recall@1 = 0.0', () => {
    const agg = aggregateRecallAtK(queries, 1);
    expect(agg.mono).toBe(1);
    expect(agg.cross).toBe(0);
    expect(agg.n).toBe(3);
  });

  it('cross recall@3 = 0.5 (one of two cross hits within 3)', () => {
    expect(aggregateRecallAtK(queries, 3).cross).toBe(0.5);
  });

  it('empty input → null everywhere', () => {
    const agg = aggregateRecallAtK([], 1);
    expect(agg.overall).toBeNull();
    expect(agg.mono).toBeNull();
    expect(agg.cross).toBeNull();
    expect(agg.n).toBe(0);
  });

  it('a partition with no members → null for that partition only', () => {
    const monoOnly: RetrievalQuery[] = [{ ranked: ['x'], goldRef: 'x', direction: 'mono' }];
    const agg = aggregateRecallAtK(monoOnly, 1);
    expect(agg.mono).toBe(1);
    expect(agg.cross).toBeNull();
  });
});

describe('aggregateNdcgAtK', () => {
  it('averages ndcg across queries', () => {
    const queries: RetrievalQuery[] = [
      { ranked: ['x'], goldRef: 'x', direction: 'mono' }, // 1.0
      { ranked: ['a', 'x'], goldRef: 'x', direction: 'cross' }, // 1/log2(3)
    ];
    const agg = aggregateNdcgAtK(queries, 10);
    expect(agg.overall).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 6);
    expect(agg.mono).toBeCloseTo(1, 6);
    expect(agg.cross).toBeCloseTo(1 / Math.log2(3), 6);
  });
});
