/**
 * Unit coverage for the G8 trace-derived usage ranking factor (Spectron
 * "eight signals" — prior retrieval success feeding ranking). The
 * fact_usage.readCount enters search ranking multiplicatively, EXACTLY
 * mirroring the fact_trust trustFactor shape:
 *
 *   usageFactor = 1 + β·squash(readCount)
 *
 * Double-gated: β defaults 0 (factor exactly 1.0, no breakdown field)
 * AND a fact search never surfaced (readCount absent/0) is unaffected at
 * ANY β. The squash is log1p-saturating so a few reads help and a hot
 * fact never dominates.
 */
import { scoreRows } from '../src/search/internals/scoring';
import type { FusedRow } from '../src/search/internals/types';

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

describe('scoreRows — G8 usage ranking factor', () => {
  it('is byte-identical with beta 0, readCount present or not', () => {
    const rows = [row(), row({ readCount: 50 })];
    const base = scoreRows({ rows, now: NOW });
    const flagged = scoreRows({ rows, now: NOW, usageBeta: 0 });
    expect(flagged.map((s) => s.score)).toEqual(base.map((s) => s.score));
    // Off → no breakdown field at all (unaffected rows stay byte-identical).
    for (const s of [...base, ...flagged]) {
      expect(s.breakdown.usage).toBeUndefined();
    }
  });

  it('readCount 0 / absent is factor exactly 1 at ANY beta (no breakdown)', () => {
    const ranked = scoreRows({
      rows: [row(), row({ readCount: 0 })],
      now: NOW,
      usageBeta: 5,
    });
    const absent = ranked[0]!;
    const zero = ranked[1]!;
    const baseline = scoreRows({ rows: [row()], now: NOW })[0]!;
    expect(absent.score).toBe(baseline.score);
    expect(zero.score).toBe(baseline.score);
    expect(absent.breakdown.usage).toBeUndefined();
    expect(zero.breakdown.usage).toBeUndefined();
  });

  it('a used fact outranks its identical-otherwise never-used twin', () => {
    const rankedUsed = scoreRows({
      rows: [row({ readCount: 10 }), row()],
      now: NOW,
      usageBeta: 0.5,
    });
    const used = rankedUsed[0]!;
    const unused = rankedUsed[1]!;
    expect(used.score).toBeGreaterThan(unused.score);
    expect(used.breakdown.usage?.readCount).toBe(10);
    expect(used.breakdown.usage?.usageFactor).toBeGreaterThan(1);
  });

  it('more reads rank higher (monotonic in readCount below saturation)', () => {
    const rankedReads = scoreRows({
      rows: [row({ readCount: 2 }), row({ readCount: 15 })],
      now: NOW,
      usageBeta: 0.5,
      usageSaturation: 20,
    });
    const few = rankedReads[0]!;
    const many = rankedReads[1]!;
    expect(many.score).toBeGreaterThan(few.score);
    expect(many.breakdown.usage!.usageFactor).toBeGreaterThan(
      few.breakdown.usage!.usageFactor,
    );
  });

  it('saturation caps the boost: usageFactor never exceeds 1 + beta', () => {
    const beta = 0.5;
    const rankedSat = scoreRows({
      rows: [row({ readCount: 20 }), row({ readCount: 100_000 })],
      now: NOW,
      usageBeta: beta,
      usageSaturation: 20,
    });
    const atSat = rankedSat[0]!;
    const farBeyond = rankedSat[1]!;
    // At readCount === saturation the squash is ~1.0 → factor ~1 + beta.
    expect(atSat.breakdown.usage!.usageFactor).toBeCloseTo(1 + beta, 5);
    // A hot fact is clamped: squash capped at 1 → factor === 1 + beta exactly.
    expect(farBeyond.breakdown.usage!.usageFactor).toBeCloseTo(1 + beta, 10);
    expect(farBeyond.breakdown.usage!.usageFactor).toBeLessThanOrEqual(1 + beta);
  });

  it('surfaces raw readCount + usageFactor in the breakdown (explain/debug)', () => {
    const scored = scoreRows({
      rows: [row({ readCount: 7 })],
      now: NOW,
      usageBeta: 0.3,
      usageSaturation: 20,
    })[0]!;
    // log1p(7)/log1p(20) = ln(8)/ln(21) ≈ 0.6830; factor ≈ 1 + 0.3·0.6830 ≈ 1.2049.
    expect(scored.breakdown.usage).toMatchObject({ readCount: 7 });
    expect(scored.breakdown.usage!.usageFactor).toBeCloseTo(1.2049, 4);
    // The factor is exactly the multiplier applied to finalScore.
    expect(scored.breakdown.finalScore).toBeCloseTo(
      scored.breakdown.fusedScore *
        scored.breakdown.decay *
        (scored.breakdown.calibratedConfidence ?? scored.breakdown.confidence) *
        scored.breakdown.usage!.usageFactor,
      6,
    );
  });
});
