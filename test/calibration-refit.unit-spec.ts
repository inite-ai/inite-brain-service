import {
  aggregateBySourceKey,
  isCorrect,
} from '../src/ai/calibration/calibration-refit-runner.service';

describe('calibration-refit pure helpers', () => {
  describe('aggregateBySourceKey', () => {
    it('rolls wins + losses per sourceKey', () => {
      const out = aggregateBySourceKey([
        { sourceKey: 'rent:bot', win: 1, loss: 0 },
        { sourceKey: 'rent:bot', win: 1, loss: 0 },
        { sourceKey: 'rent:bot', win: 0, loss: 1 },
        { sourceKey: 'shop:cli', win: 0, loss: 1 },
      ]);
      const rent = out.find((r) => r.sourceKey === 'rent:bot');
      const shop = out.find((r) => r.sourceKey === 'shop:cli');
      expect(rent).toEqual({ sourceKey: 'rent:bot', wins: 2, losses: 1 });
      expect(shop).toEqual({ sourceKey: 'shop:cli', wins: 0, losses: 1 });
    });

    it('returns empty array for empty input', () => {
      expect(aggregateBySourceKey([])).toEqual([]);
    });

    it('keeps every sourceKey, including those with only losses', () => {
      const out = aggregateBySourceKey([
        { sourceKey: 'k1', win: 0, loss: 1 },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].wins).toBe(0);
      expect(out[0].losses).toBe(1);
    });
  });

  describe('isCorrect', () => {
    it('active + no retract → correct', () => {
      expect(
        isCorrect({ status: 'active', retractedAt: null, retractionReason: null }),
      ).toBe(true);
    });

    it('superseded → incorrect', () => {
      expect(
        isCorrect({
          status: 'superseded',
          retractedAt: '2026-06-01',
          retractionReason: 'superseded',
        }),
      ).toBe(false);
    });

    it('retracted → incorrect', () => {
      expect(
        isCorrect({
          status: 'retracted',
          retractedAt: '2026-06-01',
          retractionReason: 'user_requested',
        }),
      ).toBe(false);
    });

    it('competing status (not yet resolved) → still treated as correct', () => {
      // Competing is a transient state — the resolver hasn't decided
      // yet, so we don't penalise calibration on it. Conservative
      // default. Once the resolver picks a winner, the loser flips
      // to superseded and the next refit captures it.
      expect(
        isCorrect({
          status: 'competing',
          retractedAt: null,
          retractionReason: null,
        }),
      ).toBe(true);
    });
  });
});
