import { score, type Assignment, type Mention } from './eval/entity-resolution/score';

const M = (id: string, cluster: string, category = 'x'): Mention => ({ id, cluster, category });
const A = (mentionId: string, entityId: string, rung: string): Assignment => ({
  mentionId,
  entityId,
  rung,
});

describe('entity-resolution battery scorer', () => {
  it('a perfect run scores 1 on every metric', () => {
    const mentions = [M('a', 'p', 'first'), M('b', 'p', 'translit'), M('c', 'q', 'first')];
    const s = score(mentions, [
      A('a', 'e1', 'created'),
      A('b', 'e1', 'translit'),
      A('c', 'e2', 'created'),
    ]);
    expect(s.pairwise).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      truePairs: 1,
      correctPairs: 1,
    });
    expect(s.bcubed).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(s.autoMerge).toEqual({ attached: 1, correct: 1, precision: 1 });
    expect(s.escalation).toEqual({ links: 1, settledByLadder: 1, byJudge: 0, missed: 0 });
    expect(s.falseMerges).toEqual([]);
  });

  it('a missed link costs recall, not precision, and is listed', () => {
    const mentions = [M('a', 'p', 'first'), M('b', 'p', 'nickname')];
    const s = score(mentions, [A('a', 'e1', 'created'), A('b', 'e2', 'created')]);
    expect(s.pairwise).toMatchObject({ precision: 1, recall: 0, predictedPairs: 0 });
    expect(s.bcubed.precision).toBe(1);
    expect(s.bcubed.recall).toBe(0.5);
    expect(s.missedLinks).toEqual([
      { mentionId: 'b', cluster: 'p', category: 'nickname', rung: 'created' },
    ]);
    expect(s.escalation.missed).toBe(1);
  });

  it('a false merge by a deterministic rung counts against auto-merge precision', () => {
    const mentions = [M('a', 'p', 'first'), M('b', 'q', 'same-name-different')];
    const s = score(mentions, [A('a', 'e1', 'created'), A('b', 'e1', 'exact')]);
    expect(s.pairwise).toMatchObject({ precision: 0, predictedPairs: 1, correctPairs: 0 });
    expect(s.autoMerge).toEqual({ attached: 1, correct: 0, precision: 0 });
    expect(s.falseMerges).toEqual([{ mentionId: 'b', entityHolds: ['p'], rung: 'exact' }]);
    expect(s.categories.find((c) => c.category === 'same-name-different')?.falseMerges).toBe(1);
  });

  it('a link settled by the judge is escalation, not a ladder hit', () => {
    const mentions = [M('a', 'p', 'first'), M('b', 'p', 'abbreviation')];
    const s = score(mentions, [A('a', 'e1', 'created'), A('b', 'e1', 'judge')]);
    expect(s.escalation).toEqual({ links: 1, settledByLadder: 0, byJudge: 1, missed: 0 });
    expect(s.autoMerge.attached).toBe(0);
    expect(s.rungs).toEqual({ created: 1, judge: 1 });
  });

  it('B³ weighs each mention: a split cluster of three halves recall unevenly', () => {
    const mentions = [M('a', 'p'), M('b', 'p'), M('c', 'p')];
    const s = score(mentions, [
      A('a', 'e1', 'created'),
      A('b', 'e1', 'exact'),
      A('c', 'e2', 'created'),
    ]);
    // a, b: 2/3 of their cluster on their entity; c: 1/3.
    expect(s.bcubed.recall).toBeCloseTo((2 / 3 + 2 / 3 + 1 / 3) / 3);
    expect(s.bcubed.precision).toBe(1);
  });
});
