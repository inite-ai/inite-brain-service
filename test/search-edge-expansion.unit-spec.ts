import {
  selectEdgeExpansionSeeds,
  mergeExpandedNeighbours,
} from '../src/search/internals/edge-expansion';

describe('selectEdgeExpansionSeeds', () => {
  const sel = selectEdgeExpansionSeeds;
  const mkBuckets = (entries: Array<[string, number]>) =>
    new Map(entries.map(([id, rs]) => [id, { entityId: id, rankScore: rs }]));

  it('returns empty list when topN ≤ 0', () => {
    const m = mkBuckets([
      ['a', 1],
      ['b', 0.5],
    ]);
    expect(sel(m, 0)).toEqual([]);
    expect(sel(m, -1)).toEqual([]);
  });

  it('skips buckets with non-positive rankScore', () => {
    const m = mkBuckets([
      ['a', 0],
      ['b', 0.5],
      ['c', -0.1],
    ]);
    const out = sel(m, 5);
    expect(out.map((s) => s.entityId)).toEqual(['b']);
  });

  it('picks top-N by rankScore descending', () => {
    const m = mkBuckets([
      ['a', 0.1],
      ['b', 0.9],
      ['c', 0.5],
      ['d', 0.2],
    ]);
    const out = sel(m, 2);
    expect(out.map((s) => s.entityId)).toEqual(['b', 'c']);
  });

  it('returns all positive-score buckets when topN exceeds map size', () => {
    const m = mkBuckets([
      ['a', 1],
      ['b', 2],
    ]);
    const out = sel(m, 10);
    expect(out.map((s) => s.entityId)).toEqual(['b', 'a']);
  });
});

describe('mergeExpandedNeighbours', () => {
  const merge = mergeExpandedNeighbours;
  type Bucket = {
    entityId: string;
    rankScore: number;
    bestScore: number;
    facts: any[];
  };
  const mkMap = (entries: Array<[string, number]>): Map<string, Bucket> =>
    new Map(
      entries.map(([id, rs]) => [
        id,
        { entityId: id, rankScore: rs, bestScore: rs, facts: [] },
      ]),
    );

  it('returns 0 when α ≤ 0', () => {
    const m = mkMap([['a', 1]]);
    const injected = merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 1,
          neighbourEntityId: 'b',
          edgeWeight: 1,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 0,
            bestScore: 0,
            facts: [],
          }),
        },
      ],
      0,
    );
    expect(injected).toBe(0);
    expect(m.has('b')).toBe(false);
  });

  it('does not inject a neighbour that already has a bucket', () => {
    const m = mkMap([
      ['a', 1],
      ['b', 0.3],
    ]);
    const bBefore = { ...m.get('b')! };
    const injected = merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 1,
          neighbourEntityId: 'b',
          edgeWeight: 1,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 99,
            bestScore: 99,
            facts: [],
          }),
        },
      ],
      0.5,
    );
    expect(injected).toBe(0);
    // Existing bucket is untouched — vector evidence wins over graph inheritance.
    expect(m.get('b')).toEqual(bBefore);
  });

  it('injects new neighbour with rankScore = α × seedRankScore × edgeWeight', () => {
    const m = mkMap([['a', 1.0]]);
    const injected = merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 1.0,
          neighbourEntityId: 'b',
          edgeWeight: 0.8,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 0,
            bestScore: 0,
            facts: [{ predicate: 'p', object: 'o' }],
          }),
        },
      ],
      0.4,
    );
    expect(injected).toBe(1);
    const b = m.get('b')!;
    expect(b.rankScore).toBeCloseTo(0.4 * 1.0 * 0.8, 6);
    expect(b.bestScore).toBeCloseTo(0.32, 6);
    expect(b.facts).toHaveLength(1);
  });

  it('when same neighbour reachable from multiple seeds, keeps MAX inherited (not sum)', () => {
    const m = mkMap([
      ['a', 1.0],
      ['c', 0.5],
    ]);
    const injected = merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 1.0,
          neighbourEntityId: 'b',
          edgeWeight: 1.0,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 0,
            bestScore: 0,
            facts: ['fromA'],
          }),
        },
        {
          seedEntityId: 'c',
          seedRankScore: 0.5,
          neighbourEntityId: 'b',
          edgeWeight: 1.0,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 0,
            bestScore: 0,
            facts: ['fromC'],
          }),
        },
      ],
      0.4,
    );
    expect(injected).toBe(1);
    const b = m.get('b')!;
    // MAX(0.4 × 1.0 × 1.0, 0.4 × 0.5 × 1.0) = 0.4 — NOT 0.6 (sum)
    expect(b.rankScore).toBeCloseTo(0.4, 6);
  });

  it('skips expansion tuples whose inherited score is 0 (seed with rankScore 0)', () => {
    const m = mkMap([['a', 0]]);
    const injected = merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 0,
          neighbourEntityId: 'b',
          edgeWeight: 1,
          bucketFactory: () => ({
            entityId: 'b',
            rankScore: 0,
            bestScore: 0,
            facts: [],
          }),
        },
      ],
      0.4,
    );
    expect(injected).toBe(0);
    expect(m.has('b')).toBe(false);
  });

  it('factory is invoked at most once per injected neighbour', () => {
    const m = mkMap([
      ['a', 1.0],
      ['c', 0.5],
    ]);
    const factory = jest.fn(() => ({
      entityId: 'b',
      rankScore: 0,
      bestScore: 0,
      facts: [],
    }));
    merge(
      m,
      [
        {
          seedEntityId: 'a',
          seedRankScore: 1.0,
          neighbourEntityId: 'b',
          edgeWeight: 1.0,
          bucketFactory: factory,
        },
        {
          seedEntityId: 'c',
          seedRankScore: 0.5,
          neighbourEntityId: 'b',
          edgeWeight: 1.0,
          bucketFactory: factory,
        },
      ],
      0.4,
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
