import { bucketByEntity, scoreRows } from '../src/search/internals/scoring';
import { assembleHits } from '../src/search/internals/response-builder';
import type {
  ScoredRow,
  FactRow,
  FusedRow,
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

describe('scoreRows chatter penalty', () => {
  // Fixed recordedAt + now = same instant → decay is exactly 1 for BOTH
  // predicates, isolating the chatter factor from the said/preference
  // half-life difference.
  const AT = '2026-01-01T00:00:00.000Z';
  const NOW = Date.parse(AT);
  const fused = (predicate: string, object: string): FusedRow => ({
    ...fact({ predicate, object, recordedAt: AT, validFrom: AT }),
    fusedScore: 1,
  });

  it('demotes a said fact below a substantive fact at equal fusedScore', () => {
    const [said, pref] = scoreRows({
      rows: [fused('said', 'Hey Mel!'), fused('preference', 'sunsets')],
      predicateDist: null,
      now: NOW,
      chatterPenalty: 0.35,
    });
    expect(said.score).toBeLessThan(pref.score);
    expect(said.breakdown.chatterPenalty).toBe(0.35);
    // Substantive fact is untouched — no chatterPenalty field.
    expect(pref.breakdown.chatterPenalty).toBeUndefined();
  });

  it('penalty 1.0 (default/off) → byte-identical scores, no breakdown field', () => {
    const [said, pref] = scoreRows({
      rows: [fused('said', 'Hey Mel!'), fused('preference', 'sunsets')],
      predicateDist: null,
      now: NOW,
    });
    expect(said.score).toBeCloseTo(pref.score, 10);
    expect(said.breakdown.chatterPenalty).toBeUndefined();
  });

  it('an out-of-range penalty (≥1) is treated as off', () => {
    const [said] = scoreRows({
      rows: [fused('said', 'x')],
      predicateDist: null,
      now: NOW,
      chatterPenalty: 1.5,
    });
    expect(said.breakdown.chatterPenalty).toBeUndefined();
  });
});

describe('assembleHits fact-window shaping', () => {
  const bucket = (facts: ScoredRow[]): EntityBucket => ({
    entityId: 'knowledge_entity:e1',
    rankScore: 1,
    bestScore: 1,
    facts,
  });

  it('caps facts per entity at factsPerEntity (default 5, raisable)', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      scored(fact({ predicate: `p${i}`, object: `v${i}` }), 1 - i * 0.01),
    );
    const def = assembleHits({
      topEntities: [bucket(many)],
      backfillByEntity: new Map(),
      entityTypes: undefined,
    });
    expect(def[0].facts).toHaveLength(5);

    const wide = assembleHits({
      topEntities: [bucket(many)],
      backfillByEntity: new Map(),
      entityTypes: undefined,
      factsPerEntity: 10,
    });
    expect(wide[0].facts).toHaveLength(10);
  });

  it('backfillPerPredicate=2 lets a second same-predicate fact surface', () => {
    const matched = scored(fact({ predicate: 'preference', object: 'sunsets' }), 1);
    const backfillSamePred: FactRow = fact({
      predicate: 'preference',
      object: 'transgender woman',
    });
    // Default (1): the same-predicate backfill fact is skipped.
    const def = assembleHits({
      topEntities: [bucket([matched])],
      backfillByEntity: new Map([['knowledge_entity:e1', [backfillSamePred]]]),
      entityTypes: undefined,
    });
    expect(def[0].facts.map((f) => f.object)).toEqual(['sunsets']);
    // Relaxed (2): it surfaces.
    const relaxed = assembleHits({
      topEntities: [bucket([matched])],
      backfillByEntity: new Map([['knowledge_entity:e1', [backfillSamePred]]]),
      entityTypes: undefined,
      backfillPerPredicate: 2,
    });
    expect(relaxed[0].facts.map((f) => f.object)).toContain('transgender woman');
  });

  it('orders backfill by query relevance when the widened window is on', () => {
    const older = '2020-01-01T00:00:00.000Z';
    const newer = '2025-01-01T00:00:00.000Z';
    // Recent but irrelevant vs older but query-relevant.
    const irrelevant = fact({ predicate: 'a', object: 'weather chatter', recordedAt: newer });
    const relevant = fact({ predicate: 'b', object: 'transgender identity', recordedAt: older });
    const hits = assembleHits({
      topEntities: [bucket([scored(fact({ predicate: 'name', object: 'Caroline' }), 1)])],
      backfillByEntity: new Map([
        ['knowledge_entity:e1', [irrelevant, relevant]],
      ]),
      entityTypes: undefined,
      factsPerEntity: 2, // name + exactly one backfill slot
      backfillPerPredicate: 2, // opt into relevance-ordered backfill
      query: 'what is her identity',
    });
    const objs = hits[0].facts.map((f) => f.object);
    expect(objs).toContain('transgender identity'); // relevance beat recency
    expect(objs).not.toContain('weather chatter');
  });

  it('default (backfillPerPredicate=1) keeps pure recency — byte-identical', () => {
    const older = '2020-01-01T00:00:00.000Z';
    const newer = '2025-01-01T00:00:00.000Z';
    const irrelevant = fact({ predicate: 'a', object: 'weather chatter', recordedAt: newer });
    const relevant = fact({ predicate: 'b', object: 'transgender identity', recordedAt: older });
    const hits = assembleHits({
      topEntities: [bucket([scored(fact({ predicate: 'name', object: 'Caroline' }), 1)])],
      backfillByEntity: new Map([
        ['knowledge_entity:e1', [irrelevant, relevant]],
      ]),
      entityTypes: undefined,
      factsPerEntity: 2,
      query: 'what is her identity',
      // no backfillPerPredicate → default 1 → relevance-order disabled.
    });
    const objs = hits[0].facts.map((f) => f.object);
    expect(objs).toContain('weather chatter'); // newest wins, query ignored
    expect(objs).not.toContain('transgender identity');
  });
});
