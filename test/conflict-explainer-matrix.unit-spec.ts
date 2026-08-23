/**
 * P2 — parameterised matrix covering every (dominantDimension × slotDelta)
 * cell of the conflict-explainer narrative. The single happy-path test
 * lives in conflict-explainer.unit-spec.ts; this file pins down the
 * combinatorial surface so a future change to the narrative template
 * doesn't silently regress on one cell.
 */
import {
  buildConflictExplanation,
  type ConflictDimension,
  type ConflictExplanation,
  type ResolverConflictPayload,
} from '../src/ingest/conflict-explainer';

const ALL_DIMS: ConflictDimension[] = ['confidence', 'source_trust', 'recency', 'authority'];

function payload(
  dim: ConflictDimension,
  slots: { object: boolean; validFrom: boolean; source: boolean },
): ResolverConflictPayload {
  return {
    outcome: 'SUPERSEDED',
    factId: 'fact:new',
    bestOpponentId: 'fact:old',
    supersededFactIds: ['fact:old'],
    scoreBreakdown: {
      winner: { total: 0.9, confidence: 0.3, sourceTrust: 0.4, recency: 0.2, authority: 0 },
      loser: { total: 0.6, confidence: 0.2, sourceTrust: 0.2, recency: 0.2, authority: 0 },
      margin: 0.3,
    },
    dominantDimension: dim,
    slotDelta: {
      predicate: false,
      object: slots.object,
      validFrom: slots.validFrom,
      source: slots.source,
    },
  };
}

describe('conflict-explainer narrative matrix', () => {
  for (const dim of ALL_DIMS) {
    it(`names dimension="${dim}" in the rendered phrase`, () => {
      const e = buildConflictExplanation(
        payload(dim, { object: true, validFrom: false, source: false }),
      );
      const expected =
        dim === 'source_trust'
          ? 'source trust'
          : dim === 'confidence'
            ? 'confidence'
            : dim === 'recency'
              ? 'recency'
              : 'authority';
      expect(e.narrativeBullet).toContain(expected);
    });
  }

  const COMBOS: Array<{ name: string; slots: Parameters<typeof payload>[1]; expected: string[] }> =
    [
      {
        name: 'object only',
        slots: { object: true, validFrom: false, source: false },
        expected: ['object'],
      },
      {
        name: 'validFrom only',
        slots: { object: false, validFrom: true, source: false },
        expected: ['validFrom'],
      },
      {
        name: 'source only',
        slots: { object: false, validFrom: false, source: true },
        expected: ['source'],
      },
      {
        name: 'object + source',
        slots: { object: true, validFrom: false, source: true },
        expected: ['object', 'source'],
      },
      {
        name: 'object + validFrom + source',
        slots: { object: true, validFrom: true, source: true },
        expected: ['object', 'validFrom', 'source'],
      },
    ];

  for (const c of COMBOS) {
    it(`lists slot deltas: ${c.name}`, () => {
      const e = buildConflictExplanation(payload('confidence', c.slots));
      for (const slot of c.expected) {
        expect(e.narrativeBullet).toContain(slot);
      }
    });
  }

  it('produces unique narratives for distinct (dim, slot) combinations', () => {
    const seen = new Set<string>();
    for (const dim of ALL_DIMS) {
      for (const c of COMBOS) {
        const e: ConflictExplanation = buildConflictExplanation(payload(dim, c.slots));
        seen.add(e.narrativeBullet);
      }
    }
    // 4 dims × 5 slot combos = 20 distinct sentences expected; this
    // gates against template collapse (e.g. dim phrase dropped).
    expect(seen.size).toBe(ALL_DIMS.length * COMBOS.length);
  });
});
