/**
 * Unit coverage for the source-reputation Phase 5 read-time composite:
 * fact_trust enters search ranking multiplicatively, double-gated —
 * flags default 0 (factors exactly 1.0) AND snapshot-less facts sit on
 * the neutral 0.5 (factor 1.0 at ANY β).
 */
import { scoreRows } from '../src/search/internals/scoring';
import type { FusedRow } from '../src/search/internals/types';
import { applyConformalGuardrail } from '../src/synthesize/conformal-guardrail';
import type { SearchHit } from '../src/search/search.types';

const NOW = Date.parse('2026-07-09T00:00:00Z');

function row(over: Partial<FusedRow> = {}): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'status',
    object: 'active',
    confidence: 0.9,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: new Date(NOW).toISOString(),
    status: 'active',
    source: { vertical: 'rent' },
    fusedScore: 1,
    ...over,
  } as FusedRow;
}

describe('scoreRows — fact_trust factors', () => {
  it('is byte-identical with flags at 0, snapshot or not', () => {
    const rows = [
      row(),
      row({
        trustSnapshot: { learnedTrust: 0.95, authority: 1 },
        corroboration: { count: 3 },
      }),
    ];
    const base = scoreRows({ rows, now: NOW });
    const flagged = scoreRows({
      rows,
      now: NOW,
      trustBeta: 0,
      corroborationGamma: 0,
      authorityDelta: 0,
    });
    expect(flagged.map((s) => s.score)).toEqual(base.map((s) => s.score));
    for (const s of flagged) {
      expect(s.breakdown.factTrust?.trustFactor).toBe(1);
      expect(s.breakdown.factTrust?.corroborationFactor).toBe(1);
      expect(s.breakdown.factTrust?.authorityFactor).toBe(1);
    }
  });

  it('a snapshot-less fact sits on the neutral 0.5 at ANY beta', () => {
    const [scored] = scoreRows({
      rows: [row()],
      now: NOW,
      trustBeta: 2,
    });
    expect(scored!.breakdown.factTrust?.sourceReputation).toBe(0.5);
    expect(scored!.breakdown.factTrust?.trustFactor).toBe(1);
  });

  it('beta scales the snapshot ladder: learnedTrust ?? declaredTrust ?? 0.5', () => {
    const [learned, declaredOnly] = scoreRows({
      rows: [
        row({ trustSnapshot: { learnedTrust: 0.9, declaredTrust: 0.5 } }),
        row({ trustSnapshot: { declaredTrust: 0.7 } }),
      ],
      now: NOW,
      trustBeta: 1,
    });
    expect(learned!.breakdown.factTrust?.trustFactor).toBeCloseTo(1.4);
    expect(declaredOnly!.breakdown.factTrust?.trustFactor).toBeCloseTo(1.2);
    // trusted fact outranks the identical-otherwise less-trusted one
    expect(learned!.score).toBeGreaterThan(declaredOnly!.score);
  });

  it('gamma rewards corroboration, capped at 3', () => {
    const [three, ten] = scoreRows({
      rows: [row({ corroboration: { count: 3 } }), row({ corroboration: { count: 10 } })],
      now: NOW,
      corroborationGamma: 0.1,
    });
    expect(three!.breakdown.factTrust?.corroborationFactor).toBeCloseTo(1.3);
    expect(ten!.breakdown.factTrust?.corroborationFactor).toBeCloseTo(1.3);
  });

  it('delta scales registry authority; no registry entry is unaffected at ANY delta', () => {
    const [authoritative, unregistered] = scoreRows({
      rows: [
        row({ trustSnapshot: { authority: 0.8 } }),
        row(), // no snapshot → authority 0
      ],
      now: NOW,
      authorityDelta: 0.5,
    });
    expect(authoritative!.breakdown.factTrust?.authorityFactor).toBeCloseTo(1.4);
    expect(unregistered!.breakdown.factTrust?.authorityFactor).toBe(1);
    expect(authoritative!.score).toBeGreaterThan(unregistered!.score);
  });

  it('surfaces the "because" decomposition (authority + evidence count)', () => {
    const [scored] = scoreRows({
      rows: [
        row({
          trustSnapshot: { learnedTrust: 0.8, authority: 0.9 },
          source: {
            vertical: 'rent',
            evidence: [
              { kind: 'url', ref: 'https://x' },
              { kind: 'commit', ref: 'abc' },
            ],
          },
        }),
      ],
      now: NOW,
    });
    expect(scored!.breakdown.factTrust).toMatchObject({
      sourceReputation: 0.8,
      authority: 0.9,
      evidenceCount: 2,
    });
  });
});

describe('applyConformalGuardrail — minFactTrust floor', () => {
  const hit = (trust: number | undefined): SearchHit =>
    ({
      entityId: 'knowledge_entity:e',
      entityType: 'customer',
      canonicalName: 'X',
      externalRefs: {},
      score: 1,
      facts: [
        {
          factId: 'knowledge_fact:f',
          predicate: 'status',
          object: 'active',
          confidence: 0.9,
          validFrom: '2026-01-01T00:00:00Z',
          status: 'active',
          score: 1,
          breakdown: {
            fusedScore: 1,
            confidence: 0.9,
            calibratedConfidence: 0.9,
            decay: 1,
            ...(trust !== undefined
              ? {
                  factTrust: {
                    sourceReputation: trust,
                    authority: 0,
                    corroborationCount: 0,
                    evidenceCount: 0,
                    trustFactor: 1,
                    corroborationFactor: 1,
                  },
                }
              : {}),
            finalScore: 1,
            stages: [],
          },
        },
      ],
    }) as SearchHit;

  it('is a no-op at floor 0', () => {
    const out = applyConformalGuardrail([hit(0.1)], {
      minCalibratedConfidence: 0,
      minFactTrust: 0,
    });
    expect(out.droppedCount).toBe(0);
  });

  it('drops facts from sources that EARNED distrust', () => {
    const out = applyConformalGuardrail([hit(0.2)], {
      minCalibratedConfidence: 0,
      minFactTrust: 0.4,
    });
    expect(out.droppedCount).toBe(1);
    expect(out.kept).toHaveLength(0);
  });

  it('never drops unscored facts at floors ≤ 0.5 (neutral fallback)', () => {
    const out = applyConformalGuardrail([hit(undefined)], {
      minCalibratedConfidence: 0,
      minFactTrust: 0.5,
    });
    expect(out.droppedCount).toBe(0);
    expect(out.kept).toHaveLength(1);
  });
});
