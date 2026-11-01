import { isCorrect } from '../src/ai/calibration/calibration-refit-runner.service';

describe('calibration-refit pure helpers', () => {
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
