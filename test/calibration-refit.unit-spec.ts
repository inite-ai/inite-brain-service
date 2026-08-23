import {
  aggregateByScope,
  scopeKeyOf,
  isCorrect,
} from '../src/ai/calibration/calibration-refit-runner.service';

describe('calibration-refit pure helpers', () => {
  describe('aggregateByScope', () => {
    const T1 = '2026-01-01T00:00:00Z';
    const T2 = '2026-02-01T00:00:00Z';

    it('rolls wins + losses at BOTH grains: (sourceKey, domain) and global', () => {
      const out = aggregateByScope([
        { sourceKey: 'rent:bot', domain: 'status', win: 1, loss: 0, recordedAt: T1 },
        { sourceKey: 'rent:bot', domain: 'status', win: 1, loss: 0, recordedAt: T2 },
        { sourceKey: 'rent:bot', domain: 'address', win: 0, loss: 1, recordedAt: T1 },
        { sourceKey: 'shop:cli', domain: 'status', win: 0, loss: 1, recordedAt: T1 },
      ]);
      const byKey = new Map(out.map((s) => [scopeKeyOf(s.sourceKey, s.domain), s]));

      // Scoped rows: the broker analogy — great on one predicate, weak on
      // another, and the two never blend.
      expect(byKey.get(scopeKeyOf('rent:bot', 'status'))).toMatchObject({
        wins: 2,
        losses: 0,
      });
      expect(byKey.get(scopeKeyOf('rent:bot', 'address'))).toMatchObject({
        wins: 0,
        losses: 1,
      });
      // Global row = the pre-0045 blended rate, untouched in meaning.
      expect(byKey.get(scopeKeyOf('rent:bot', null))).toMatchObject({
        wins: 2,
        losses: 1,
      });
      expect(byKey.get(scopeKeyOf('shop:cli', null))).toMatchObject({
        wins: 0,
        losses: 1,
      });
    });

    it('tracks lastSeenAt as the max recordedAt per scope', () => {
      const out = aggregateByScope([
        { sourceKey: 'k', domain: 'status', win: 1, loss: 0, recordedAt: T2 },
        { sourceKey: 'k', domain: 'status', win: 1, loss: 0, recordedAt: T1 },
      ]);
      for (const scope of out) {
        expect(scope.lastSeenAt.toISOString()).toBe(new Date(T2).toISOString());
      }
    });

    it('returns empty array for empty input', () => {
      expect(aggregateByScope([])).toEqual([]);
    });

    it('keeps loss-only scopes', () => {
      const out = aggregateByScope([
        { sourceKey: 'k1', domain: 'tier', win: 0, loss: 1, recordedAt: T1 },
      ]);
      expect(out).toHaveLength(2); // scoped + global
      expect(out.every((s) => s.wins === 0 && s.losses === 1)).toBe(true);
    });
  });

  describe('isCorrect', () => {
    it('active + no retract → correct', () => {
      expect(isCorrect({ status: 'active', retractedAt: null, retractionReason: null })).toBe(true);
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
