import { bucketByEntity } from '../src/search/internals/scoring';
import { assembleHits } from '../src/search/internals/response-builder';
import type {
  ScoredRow,
  FactRow,
  EntityBucket,
} from '../src/search/internals/types';

function fact(
  partial: Partial<FactRow> & { predicate: string; object: string },
): FactRow {
  return {
    id: `fact:${partial.predicate}:${partial.object}`,
    entityId: 'knowledge_entity:e1',
    confidence: 0.9,
    validFrom: '2020-01-01T00:00:00.000Z',
    recordedAt: '2020-01-01T00:00:00.000Z',
    status: 'active',
    source: { vertical: 'support', eventId: 'ev1' },
    entity: {
      id: 'knowledge_entity:e1',
      type: 'person',
      canonicalName: 'Ada',
      externalRefs: {},
    },
    ...partial,
  };
}

function scored(f: FactRow, score: number): ScoredRow {
  return {
    row: f as ScoredRow['row'],
    score,
    breakdown: {
      fusedScore: score,
      confidence: f.confidence,
      decay: 1,
      predBoost: 1,
      finalScore: score,
      stages: ['hype'],
    },
  };
}

describe('bucketByEntity degree-boost tie', () => {
  it('counts a second fact tied at bestScore toward the degree boost', () => {
    // Two facts share the top score under DIFFERENT diversity keys. Only
    // ONE best fact should be skipped (it's already bestScore); the second
    // must contribute to the boost. Pre-fix, the `supplementary.length===0`
    // guard skipped every tied-best fact and the boost stayed 0.
    const rows = [
      scored(fact({ predicate: 'p1', object: 'A' }), 1.0),
      scored(fact({ predicate: 'p2', object: 'B' }), 1.0),
    ];
    const byEntity = bucketByEntity(rows);
    const bucket = byEntity.get('knowledge_entity:e1') as EntityBucket;
    expect(bucket.bestScore).toBe(1.0);
    // boost = one supplementary tied-best (1.0) × DEGREE_BOOST_WEIGHT(0.3)
    expect(bucket.rankScore).toBeCloseTo(1.0 + 0.3 * 1.0, 10);
  });

  it('does not double-count the single representative best fact', () => {
    const rows = [
      scored(fact({ predicate: 'p1', object: 'A' }), 1.0),
      scored(fact({ predicate: 'p2', object: 'B' }), 0.5),
    ];
    const byEntity = bucketByEntity(rows);
    const bucket = byEntity.get('knowledge_entity:e1') as EntityBucket;
    // best (1.0) skipped, supplementary = [0.5]
    expect(bucket.rankScore).toBeCloseTo(1.0 + 0.3 * 0.5, 10);
  });
});

describe('assembleHits requireProvenance', () => {
  const bucket = (facts: ScoredRow[]): EntityBucket => ({
    entityId: 'knowledge_entity:e1',
    rankScore: 1,
    bestScore: 1,
    facts,
  });

  it('keeps only facts carrying a non-empty source when requireProvenance', () => {
    const withSrc = scored(
      fact({ predicate: 'role', object: 'eng', source: { eventId: 'x' } }),
      1.0,
    );
    const noSrc = scored(
      fact({ predicate: 'hobby', object: 'chess', source: null }),
      0.8,
    );
    const hits = assembleHits({
      topEntities: [bucket([withSrc, noSrc])],
      backfillByEntity: new Map(),
      entityTypes: undefined,
      requireProvenance: true,
    });
    expect(hits).toHaveLength(1);
    const preds = hits[0].facts.map((f) => f.predicate);
    expect(preds).toContain('role');
    expect(preds).not.toContain('hobby');
  });

  it('drops an entity whose every fact lacks provenance', () => {
    const noSrc = scored(
      fact({ predicate: 'hobby', object: 'chess', source: {} }),
      0.8,
    );
    const hits = assembleHits({
      topEntities: [bucket([noSrc])],
      backfillByEntity: new Map(),
      entityTypes: undefined,
      requireProvenance: true,
    });
    expect(hits).toHaveLength(0);
  });

  it('is a no-op when requireProvenance is false', () => {
    const noSrc = scored(
      fact({ predicate: 'hobby', object: 'chess', source: null }),
      0.8,
    );
    const hits = assembleHits({
      topEntities: [bucket([noSrc])],
      backfillByEntity: new Map(),
      entityTypes: undefined,
      requireProvenance: false,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].facts).toHaveLength(1);
  });
});
