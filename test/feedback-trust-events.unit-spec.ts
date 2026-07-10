/**
 * Retrieval feedback → source-trust events: 'helpful' is a win,
 * 'incorrect' is a loss, anything else (including a smuggled
 * 'not_helpful' row) contributes nothing.
 */
import { buildFeedbackTrustEvents } from '../src/ai/calibration/calibration-refit-runner.service';

describe('buildFeedbackTrustEvents', () => {
  const row = (verdict: string) => ({
    vertical: 'rent',
    recorder: 'bot',
    predicate: 'tier',
    verdict,
    createdAt: '2026-07-09T00:00:00Z',
  });

  it('maps helpful → win, incorrect → loss, keyed by (source, predicate)', () => {
    const events = buildFeedbackTrustEvents([
      row('helpful'),
      row('incorrect'),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        sourceKey: 'rent:bot',
        domain: 'tier',
        win: 1,
        loss: 0,
      }),
      expect.objectContaining({
        sourceKey: 'rent:bot',
        domain: 'tier',
        win: 0,
        loss: 1,
      }),
    ]);
  });

  it('ignores non-reliability verdicts', () => {
    expect(buildFeedbackTrustEvents([row('not_helpful')])).toEqual([]);
    expect(buildFeedbackTrustEvents([row('bogus')])).toEqual([]);
  });

  it('falls back to the _ recorder like the fact-status events', () => {
    const [e] = buildFeedbackTrustEvents([{ ...row('helpful'), recorder: null }]);
    expect(e.sourceKey).toBe('rent:_');
  });
});
