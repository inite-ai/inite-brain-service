/**
 * Retrieval feedback → source-trust events: 'helpful' is a win,
 * 'incorrect' is a loss, anything else (including a smuggled
 * 'not_helpful' row) contributes nothing. One actor's verdict counts at
 * most once per (source, predicate, verdict) — anti-farming dedup.
 */
import { buildFeedbackTrustEvents } from '../src/ai/calibration/calibration-refit-runner.service';

describe('buildFeedbackTrustEvents', () => {
  const row = (verdict: string, actor = 'key_a') => ({
    actor,
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

  it('caps one actor at a single vote per (source, predicate, verdict)', () => {
    // key_a votes incorrect on THREE different facts of the same source —
    // the farming vector. Only one loss should land.
    const farmed = buildFeedbackTrustEvents([
      row('incorrect'),
      row('incorrect'),
      row('incorrect'),
    ]);
    expect(farmed).toHaveLength(1);
    expect(farmed[0]).toEqual(
      expect.objectContaining({ sourceKey: 'rent:bot', loss: 1 }),
    );
  });

  it('counts distinct actors separately (genuine crowd signal)', () => {
    const crowd = buildFeedbackTrustEvents([
      row('incorrect', 'key_a'),
      row('incorrect', 'key_b'),
      row('incorrect', 'key_c'),
    ]);
    expect(crowd).toHaveLength(3);
  });

  it('a helpful and an incorrect from one actor are distinct verdicts', () => {
    const mixed = buildFeedbackTrustEvents([row('helpful'), row('incorrect')]);
    expect(mixed).toHaveLength(2);
  });
});
