/**
 * Usage-based reinforcement, scoring side (migration 0053, legacy
 * SEARCH_USAGE_DECAY_ENABLED): an attached lastReadAt is a trace in the
 * fact's activation (activation.ts); rows without a usage stamp fade from
 * recordedAt alone.
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
  it('a recent read keeps the fact available', () => {
    const ranked = scoreRows({
      rows: [row(), row({ lastReadAt: new Date(NOW - DAY).toISOString() })],
      now: NOW,
    });
    const stale = ranked[0]!;
    const used = ranked[1]!;
    // 120 days at half-life 60 → (1 + 120/20)^-0.5; read a day ago → 1.
    expect(stale.breakdown.decay).toBeCloseTo((1 + 120 / 20) ** -0.5, 10);
    expect(used.breakdown.decay).toBe(1);
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

  it('no usage stamp → the trace of its creation alone', () => {
    const scored = scoreRows({
      rows: [row()],
      now: NOW,
    })[0]!;
    expect(scored.breakdown.decay).toBeCloseTo((1 + 120 / 20) ** -0.5, 10);
  });

  it('policyResolver null → the same output as omitted', () => {
    const rows = [row(), row({ lastReadAt: new Date(NOW - DAY).toISOString() })];
    const legacy = scoreRows({ rows, now: NOW });
    const withDefaults = scoreRows({ rows, now: NOW, policyResolver: null });
    expect(withDefaults.map((s) => s.score)).toEqual(legacy.map((s) => s.score));
    expect(withDefaults.map((s) => s.breakdown)).toEqual(legacy.map((s) => s.breakdown));
  });
});
