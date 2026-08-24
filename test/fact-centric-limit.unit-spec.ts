import { selectFactCentric } from '../src/search/internals/fact-centric';
import type { EntityBucket } from '../src/search/internals/types';

/**
 * Audit W4 #15 (engine-architecture-audit-2026-08.md): fact-centric
 * selection OVERWROTE the reranked window — the cross-encoder + LLM
 * rerank ran, was paid for, and its order was discarded along with PPR's
 * lift — and nothing re-sliced to `limit`, so a caller asking for 10
 * entities could receive up to the fact budget (48).
 */
function bucket(id: string, scores: number[]): EntityBucket {
  return {
    entityId: id,
    entityName: id,
    rankScore: Math.max(...scores),
    facts: scores.map((score, i) => ({
      factId: `${id}:f${i}`,
      predicate: 'p',
      object: 'o',
      score,
      confidence: 0.9,
    })),
  } as unknown as EntityBucket;
}

describe('selectFactCentric layers over the ranking (W4 #15)', () => {
  const buckets = [
    bucket('e1', [0.9, 0.4]),
    bucket('e2', [0.8]),
    bucket('e3', [0.7]),
    bucket('e4', [0.6]),
  ];

  it('honours the caller limit instead of returning the whole budget', () => {
    const out = selectFactCentric(buckets, 48, { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('keeps the reranked order for buckets the reranker judged', () => {
    // Reranker put e3 first even though e1 has the best raw fact score.
    const out = selectFactCentric(buckets, 48, {
      priority: ['e3', 'e1'],
      limit: 3,
    });
    expect(out.map((b) => b.entityId).slice(0, 2)).toEqual(['e3', 'e1']);
  });

  it('buckets outside the reranked window follow by best fact score', () => {
    const out = selectFactCentric(buckets, 48, { priority: ['e4'] });
    expect(out[0]!.entityId).toBe('e4');
    expect(out.slice(1).map((b) => b.entityId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('facts still compete globally — the budget caps facts, not entities', () => {
    const out = selectFactCentric(buckets, 2, {});
    const facts = out.reduce((a, b) => a + b.facts.length, 0);
    expect(facts).toBe(2);
    expect(out[0]!.entityId).toBe('e1');
  });

  it('no limit → legacy behaviour (every surviving bucket)', () => {
    expect(selectFactCentric(buckets, 48, {})).toHaveLength(4);
  });
});
