/**
 * The cross-encoder scoring loop (src/ai/cross-encoder/score-pairs.ts):
 * chunked forward passes under an ABSOLUTE deadline.
 *
 * Pins the contract the stage budget relies on — the loop returns a full-
 * length array before the deadline instead of overshooting it, the
 * unscored tail is -Infinity (sinks, stable), and a deadline already in
 * the past costs no forward pass at all.
 */
import { scorePairs, type PairScorer } from '../src/ai/cross-encoder/score-pairs';

/** A scorer whose forward pass takes `msPerPair` of fake time per pair. */
function fakeScorer(msPerPair: number, clock: { now: number }): PairScorer & { passes: number[] } {
  const passes: number[] = [];
  return {
    passes,
    tokenizer: async (queries, opts) => {
      expect(queries).toHaveLength(opts.text_pair.length);
      return opts.text_pair;
    },
    model: async (inputs) => {
      const docs = inputs as string[];
      passes.push(docs.length);
      clock.now += msPerPair * docs.length;
      return { logits: { data: docs.map((d) => Number(d.replace('d', ''))) } };
    },
  };
}

describe('scorePairs', () => {
  const docs = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);
  let clock: { now: number };
  let spy: jest.SpyInstance;
  beforeEach(() => {
    clock = { now: 1_000_000 };
    spy = jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
  });
  afterEach(() => spy.mockRestore());

  it('scores every pair in chunks of SCORE_CHUNK with no deadline', async () => {
    const s = fakeScorer(10, clock);
    expect(await scorePairs(s, { query: 'q', documents: docs(10) })).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(s.passes).toEqual([4, 4, 2]);
  });

  it('stops BEFORE the chunk that would cross the deadline; the tail sinks', async () => {
    // 140 ms/pair (the production host): a 4-pair chunk is 560 ms. With
    // 1000 ms left, chunk 1 fits (560), chunk 2 would end at 1120 → skipped.
    const s = fakeScorer(140, clock);
    const out = await scorePairs(s, {
      query: 'q',
      documents: docs(12),
      deadlineAt: clock.now + 1000,
    });
    expect(out.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(out.slice(4).every((v) => v === Number.NEGATIVE_INFINITY)).toBe(true);
    expect(out).toHaveLength(12);
    expect(s.passes).toEqual([4]);
  });

  it('a deadline already in the past scores nothing and runs no forward pass', async () => {
    const s = fakeScorer(10, clock);
    const out = await scorePairs(s, { query: 'q', documents: docs(3), deadlineAt: clock.now - 1 });
    expect(out).toEqual([-Infinity, -Infinity, -Infinity]);
    expect(s.passes).toEqual([]);
  });

  it('a fast host scores the whole window well inside the same budget', async () => {
    const s = fakeScorer(10, clock);
    const out = await scorePairs(s, {
      query: 'q',
      documents: docs(20),
      deadlineAt: clock.now + 1750,
    });
    expect(out).toHaveLength(20);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('a non-finite logit leaves that pair unscored rather than poisoning the sort', async () => {
    const s: PairScorer = {
      tokenizer: async (_q, o) => o.text_pair,
      model: async () => ({ logits: { data: [1.5, Number.NaN] } }),
    };
    expect(await scorePairs(s, { query: 'q', documents: ['a', 'b'] })).toEqual([
      1.5,
      Number.NEGATIVE_INFINITY,
    ]);
  });
});
