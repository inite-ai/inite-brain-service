/**
 * Unit coverage for the domain-routed retrieval scoring factor
 * (SEARCH_DOMAIN_ROUTING_ENABLED). `domainBoost` enters ranking
 * multiplicatively — absent / no-match → exactly 1.0 → byte-identical
 * scores, matched-domain facts get `×(1 + α·sim)`.
 */
import { scoreRows } from '../src/search/internals/scoring';
import type { FusedRow } from '../src/search/internals/types';

const NOW = Date.parse('2026-07-17T00:00:00Z');

function row(over: Partial<FusedRow> = {}): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'persona__life_event',
    object: 'ran a marathon',
    confidence: 0.9,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: new Date(NOW).toISOString(),
    status: 'active',
    source: { vertical: 'rent' },
    fusedScore: 1,
    ...over,
  } as FusedRow;
}

describe('scoreRows — domainBoost factor', () => {
  it('absent domainBoost is byte-identical', () => {
    const rows = [row(), row({ predicate: 'status', object: 'active' })];
    const base = scoreRows({ rows, predicateDist: null, now: NOW });
    const nulled = scoreRows({
      rows,
      predicateDist: null,
      now: NOW,
      domainBoost: null,
    });
    expect(nulled.map((s) => s.score)).toEqual(base.map((s) => s.score));
    for (const s of nulled) {
      expect(s.breakdown.domainBoost).toBeUndefined();
    }
  });

  it('boosts a matched-domain fact by (1 + alpha*sim)', () => {
    const [scored] = scoreRows({
      rows: [row()],
      predicateDist: null,
      now: NOW,
      domainBoost: {
        alpha: 0.3,
        simByPredicate: { persona__life_event: 0.8 },
      },
    });
    // fusedScore 1 × decay(365d halflife on life_event) × conf 0.9 × factor.
    const factor = 1 + 0.3 * 0.8;
    expect(scored.breakdown.domainBoost).toBeCloseTo(factor, 10);
    // The factor is exactly the ratio to the un-boosted score.
    const [base] = scoreRows({ rows: [row()], predicateDist: null, now: NOW });
    expect(scored.score / base.score).toBeCloseTo(factor, 10);
  });

  it('leaves an unmatched predicate untouched (factor 1.0, omitted)', () => {
    const [scored] = scoreRows({
      rows: [row({ predicate: 'status', object: 'active' })],
      predicateDist: null,
      now: NOW,
      domainBoost: {
        alpha: 0.3,
        simByPredicate: { persona__life_event: 0.8 },
      },
    });
    expect(scored.breakdown.domainBoost).toBeUndefined();
    const [base] = scoreRows({
      rows: [row({ predicate: 'status', object: 'active' })],
      predicateDist: null,
      now: NOW,
    });
    expect(scored.score).toBeCloseTo(base.score, 10);
  });

  it('composes with predBoost independently', () => {
    const [scored] = scoreRows({
      rows: [row()],
      predicateDist: { weights: { persona__life_event: 1 } },
      now: NOW,
      domainBoost: {
        alpha: 0.3,
        simByPredicate: { persona__life_event: 0.5 },
      },
    });
    // predBoost = 1 + 0.5(default alpha)*1 = 1.5; domainBoost = 1 + 0.3*0.5.
    expect(scored.breakdown.predBoost).toBeCloseTo(1.5, 10);
    expect(scored.breakdown.domainBoost).toBeCloseTo(1.15, 10);
  });
});
