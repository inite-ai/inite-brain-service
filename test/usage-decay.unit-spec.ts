/**
 * Usage-based reinforcement, scoring side (migration 0053): an attached
 * lastReadAt restarts the decay clock at the most recent retrieval; rows
 * without a usage stamp decay from recordedAt byte-identically to before.
 *
 * Predicate is deliberately absent from CORE_PREDICATES so policyFor
 * falls back to DEFAULT_POLICY (half-life 60 days) — deterministic.
 */
import { scoreRows } from '../src/search/internals/scoring';
import type { FactRow } from '../src/search/internals/types';

type FusedRow = FactRow & { fusedScore: number };

const NOW = Date.parse('2026-07-09T00:00:00Z');
const DAY = 86_400_000;

function row(over: Partial<FusedRow> = {}): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'usage_probe_pred',
    object: 'value',
    confidence: 0.9,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: new Date(NOW - 120 * DAY).toISOString(),
    status: 'active',
    source: { vertical: 'rent' },
    fusedScore: 1,
    ...over,
  } as FusedRow;
}

describe('scoreRows — usage-aware decay', () => {
  it('restarts the decay clock at lastReadAt', () => {
    const ranked = scoreRows({
      rows: [row(), row({ lastReadAt: new Date(NOW - DAY).toISOString() })],
      now: NOW,
    });
    const stale = ranked[0]!;
    const used = ranked[1]!;
    // 120 days at half-life 60 → 0.25; read a day ago → ~0.988.
    expect(stale.breakdown.decay).toBeCloseTo(0.25, 2);
    expect(used.breakdown.decay).toBeGreaterThan(0.95);
    expect(used.score).toBeGreaterThan(stale.score);
  });

  it('a lastReadAt older than recordedAt never penalizes', () => {
    const ranked = scoreRows({
      rows: [
        row({ recordedAt: new Date(NOW).toISOString() }),
        row({
          recordedAt: new Date(NOW).toISOString(),
          lastReadAt: new Date(NOW - 30 * DAY).toISOString(),
        }),
      ],
      now: NOW,
    });
    const fresh = ranked[0]!;
    const freshWithStaleRead = ranked[1]!;
    expect(freshWithStaleRead.score).toBe(fresh.score);
  });

  it('no usage stamp → byte-identical to the pre-0053 formula', () => {
    const scored = scoreRows({
      rows: [row()],
      now: NOW,
    })[0]!;
    expect(scored.breakdown.decay).toBeCloseTo(
      Math.exp((-Math.LN2 * 120) / 60),
      10,
    );
  });
});
