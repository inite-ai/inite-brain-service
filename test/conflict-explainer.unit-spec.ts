/**
 * The conflict explanation after #830 (0177): write time decides by valid
 * time alone, so the narrative names that rule and the facts it touched —
 * never a weighted score, which no longer exists.
 */
import { buildConflictExplanation } from '../src/ingest/conflict-explainer';

describe('buildConflictExplanation', () => {
  it('a supersede says the new value starts after the one it closed', () => {
    const e = buildConflictExplanation({
      outcome: 'SUPERSEDED',
      factId: 'knowledge_fact:new',
      bestOpponentId: 'knowledge_fact:old',
      supersededFactIds: ['knowledge_fact:old'],
    });
    expect(e).toEqual({
      outcome: 'SUPERSEDED',
      winnerFactId: 'knowledge_fact:new',
      bestOpponentFactId: 'knowledge_fact:old',
      otherLoserFactIds: [],
      decidedBy: 'valid_time',
      narrativeBullet:
        'New fact starts after the value of this slot it overlaps; it ends where the new one begins.',
    });
  });

  it('a multi-value close lists the others and counts them', () => {
    const e = buildConflictExplanation({
      outcome: 'SUPERSEDED',
      factId: 'knowledge_fact:new',
      bestOpponentId: 'knowledge_fact:a',
      supersededFactIds: ['knowledge_fact:a', 'knowledge_fact:b'],
    });
    expect(e.otherLoserFactIds).toEqual(['knowledge_fact:b']);
    expect(e.narrativeBullet).toContain('2 values');
    expect(e.narrativeBullet).toContain('they end');
  });

  it('a same-day event value is a dispute', () => {
    const e = buildConflictExplanation({
      outcome: 'COMPETING',
      factId: 'knowledge_fact:new',
      bestOpponentId: 'knowledge_fact:peer',
      competingFactIds: ['knowledge_fact:peer'],
    });
    expect(e.decidedBy).toBe('event_day');
    expect(e.narrativeBullet).toBe(
      'New fact holds on the same day as the value of this slot; both are kept as a dispute.',
    );
  });

  it('carries no score breakdown', () => {
    const e = buildConflictExplanation({
      outcome: 'SUPERSEDED',
      factId: 'f',
      bestOpponentId: 'o',
    });
    expect(Object.keys(e)).not.toContain('scoreBreakdown');
    expect(Object.keys(e)).not.toContain('dominantDimension');
  });
});
