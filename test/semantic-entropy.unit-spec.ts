import {
  clusterAcrossPasses,
  clusterEntropy,
  clusterKey,
  selfConsistencyByFact,
} from '../src/ai/extractor-internals/semantic-entropy';

describe('semantic-entropy', () => {
  it('clusters identical (predicate, object) into the same bucket across passes', () => {
    const clusters = clusterAcrossPasses([
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CTO' }],
    ]);
    expect(clusters.size).toBe(1);
    const info = [...clusters.values()][0]!;
    expect(info.count).toBe(3);
  });

  it('normalises object whitespace + case + diacritics', () => {
    const clusters = clusterAcrossPasses([
      [{ predicate: 'lives_in', object: 'São Paulo' }],
      [{ predicate: 'lives_in', object: 'sao  paulo' }],
      [{ predicate: 'lives_in', object: 'SAO PAULO' }],
    ]);
    expect(clusters.size).toBe(1);
  });

  it('keeps different predicates on the same object in different clusters', () => {
    const clusters = clusterAcrossPasses([
      [{ predicate: 'lives_in', object: 'Berlin' }],
      [{ predicate: 'works_in', object: 'Berlin' }],
    ]);
    expect(clusters.size).toBe(2);
  });

  it('deduplicates within a pass before counting (no inflated agreement)', () => {
    const clusters = clusterAcrossPasses([
      [
        { predicate: 'status', object: 'CTO' },
        { predicate: 'status', object: 'CTO' }, // dup within pass
      ],
      [{ predicate: 'status', object: 'CTO' }],
    ]);
    const info = [...clusters.values()][0]!;
    expect(info.count).toBe(2);
  });

  it('produces zero entropy when every pass agrees', () => {
    const clusters = clusterAcrossPasses([
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CTO' }],
    ]);
    expect(clusterEntropy(clusters)).toBe(0);
  });

  it('produces max entropy = log(N) on a perfectly split distribution', () => {
    const clusters = clusterAcrossPasses([
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CFO' }],
      [{ predicate: 'status', object: 'CEO' }],
    ]);
    const h = clusterEntropy(clusters);
    expect(h).toBeCloseTo(Math.log(3), 5);
  });

  it('FactSelfConsistency.agreement is per-cluster fraction of passes', () => {
    const consistency = selfConsistencyByFact([
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CTO' }],
      [{ predicate: 'status', object: 'CFO' }],
    ]);
    expect(consistency.size).toBe(2);
    expect(consistency.get(clusterKey({ predicate: 'status', object: 'CTO' }))?.agreement).toBeCloseTo(2 / 3);
    expect(consistency.get(clusterKey({ predicate: 'status', object: 'CFO' }))?.agreement).toBeCloseTo(1 / 3);
    const entropies = [...consistency.values()].map((c) => c.entropy);
    // Same entropy attached to every fact in the same cluster set.
    expect(new Set(entropies).size).toBe(1);
  });

  it('returns zero entropy on empty input', () => {
    expect(clusterEntropy(clusterAcrossPasses([]))).toBe(0);
    expect(selfConsistencyByFact([]).size).toBe(0);
  });
});
