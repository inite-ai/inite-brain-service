/**
 * #909 step 5: inferred affect is served as signals — the person's own
 * baseline, the last week against it, a weekly trend — never as state.
 */
import { shapeAffectSignals, type AffectObservationRow } from '../src/entities/affect-signals';
import { shapeRelationshipContext } from '../src/entities/relationship-context';

const now = new Date('2026-11-06T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000).toISOString();
const row = (d: number, valence: number, confidence = 1): AffectObservationRow => ({
  id: `affect_observation:${d}`,
  observedAt: daysAgo(d),
  valence,
  label: valence < 0 ? 'sadness' : 'joy',
  target: 'work',
  quote: `words ${d}`,
  confidence,
});

describe('shapeAffectSignals', () => {
  it('nothing observed → no section', () => {
    expect(shapeAffectSignals([], now)).toBeNull();
  });

  it('baseline over everything kept; last week as its deviation; confidence-weighted', () => {
    const s = shapeAffectSignals([row(1, -0.8), row(3, -0.4), row(20, 0.6), row(40, 0.6)], now)!;
    expect(s.kind).toBe('inferred');
    expect(s.baseline).toMatchObject({ meanValence: 0, n: 4, since: daysAgo(40) });
    expect(s.lastWeek).toEqual({ meanValence: -0.6, n: 2, deviation: -0.6 });
    const weighted = shapeAffectSignals([row(1, -1, 0.9), row(2, 1, 0.1)], now)!;
    expect(weighted.baseline?.meanValence).toBe(-0.8);
  });

  it('recent lists the last two weeks, newest first, with the words', () => {
    const s = shapeAffectSignals([row(20, 0.6), row(1, -0.8), row(3, -0.4)], now)!;
    expect(s.recent.map((r) => r.quote)).toEqual(['words 1', 'words 3']);
    expect(s.recent[0]).toMatchObject({ about: 'work', confidence: 1 });
  });

  it('weekly trend: weeks with observations, oldest first, at most four', () => {
    const rows = [1, 8, 15, 22, 29, 36].map((d) => row(d, 0.1));
    const s = shapeAffectSignals(rows, now)!;
    expect(s.weekly).toHaveLength(4);
    expect(s.weekly[0]!.weekStart < s.weekly[3]!.weekStart).toBe(true);
  });

  it('no observation in the last week → no lastWeek, not a zero', () => {
    expect(shapeAffectSignals([row(20, 0.5)], now)!.lastWeek).toBeUndefined();
  });

  it('never feeds state: the context keeps `known: false` with signals present', () => {
    const ctx = shapeRelationshipContext({
      userId: 'u',
      rows: [],
      now,
      affectSignals: shapeAffectSignals([row(1, -0.8)], now),
    });
    expect(ctx.state).toEqual({ known: false });
    expect(ctx.affectSignals?.recent).toHaveLength(1);
  });
});
