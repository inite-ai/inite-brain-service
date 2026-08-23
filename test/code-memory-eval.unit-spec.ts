/**
 * Code-memory Phase 3 — eval metrics (pure).
 */
import { mean, precision, recall, recallAtK, summarize } from '../src/code-memory/eval/metrics';

describe('code-memory eval metrics', () => {
  it('recall = fraction of expected retrieved', () => {
    expect(recall(['a', 'b'], ['a', 'b', 'c'])).toBe(1);
    expect(recall(['a', 'b'], ['a'])).toBe(0.5);
    expect(recall([], ['x'])).toBe(1); // vacuous
  });

  it('precision = fraction of retrieved that were expected', () => {
    expect(precision(['a'], ['a', 'x'])).toBe(0.5);
    expect(precision(['a'], [])).toBe(1); // vacuous
  });

  it('recallAtK only counts the top k', () => {
    expect(recallAtK(['a', 'b'], ['x', 'a', 'b'], 1)).toBe(0);
    expect(recallAtK(['a', 'b'], ['a', 'x', 'b'], 2)).toBe(0.5);
    expect(recallAtK(['a', 'b'], ['a', 'b', 'x'], 2)).toBe(1);
  });

  it('mean + summarize aggregate correctly', () => {
    expect(mean([1, 0])).toBe(0.5);
    const s = summarize([
      { expected: ['a'], retrieved: ['a'] },
      { expected: ['a', 'b'], retrieved: ['a'] },
    ]);
    expect(s.cases).toBe(2);
    expect(s.meanRecall).toBe(0.75);
  });
});
