/**
 * Unit sanity for the memory-fitness candidate interleave
 * (test/eval/memory-fitness/interleave.ts) — the round-robin flattener
 * feeding the d3 provenance walk. Pure fixtures, no HTTP; the harness
 * itself never runs in CI, but the budget-spreading property it relies
 * on is pinned here.
 */
import { interleaveRoundRobin } from './eval/memory-fitness/interleave';

describe('memory-fitness candidate interleave', () => {
  it('round-robins across hits: first fact of every hit before any second fact', () => {
    expect(
      interleaveRoundRobin(
        [
          ['a1', 'a2', 'a3'],
          ['b1', 'b2'],
          ['c1', 'c2', 'c3'],
        ],
        12,
      ),
    ).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'c3']);
  });

  it('a fat first hit cannot monopolise the budget (the d3 failure mode)', () => {
    const fat = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
    const out = interleaveRoundRobin([fat, ['gold1'], ['gold2']], 6);
    // Hit-major flatten + slice(0, 6) would have served f1..f6 only.
    expect(out).toContain('gold1');
    expect(out).toContain('gold2');
    expect(out).toEqual(['f1', 'gold1', 'gold2', 'f2', 'f3', 'f4']);
  });

  it('handles uneven and empty lists', () => {
    expect(interleaveRoundRobin([[], ['b1'], [], ['d1', 'd2']], 12)).toEqual(['b1', 'd1', 'd2']);
    expect(interleaveRoundRobin([], 12)).toEqual([]);
    expect(interleaveRoundRobin([[], []], 12)).toEqual([]);
  });

  it('enforces the cap mid-round', () => {
    expect(
      interleaveRoundRobin(
        [
          ['a1', 'a2'],
          ['b1', 'b2'],
          ['c1', 'c2'],
        ],
        4,
      ),
    ).toEqual(['a1', 'b1', 'c1', 'a2']);
  });

  it('a non-positive cap yields nothing', () => {
    expect(interleaveRoundRobin([['a1']], 0)).toEqual([]);
    expect(interleaveRoundRobin([['a1']], -1)).toEqual([]);
  });
});
