/**
 * ACT-R base-level activation of a processed memory
 * (src/search/internals/activation.ts): power-law traces, d = 0.5, the
 * half-life setting the scale; uses before the last spread evenly.
 */
import { activationDecay } from '../src/search/internals/activation';

const trace = (t: number, h = 60) => (1 + t / (h / 3)) ** -0.5;

describe('activationDecay', () => {
  it('is 1 for a fresh fact and one half at one half-life', () => {
    expect(activationDecay({ ageDays: 0, halfLifeDays: 60 })).toBe(1);
    expect(activationDecay({ ageDays: 60, halfLifeDays: 60 })).toBeCloseTo(0.5, 12);
    expect(activationDecay({ ageDays: 7, halfLifeDays: 7 })).toBeCloseTo(0.5, 12);
  });

  it('falls as a power law — heavier-tailed than the exponential', () => {
    const year = activationDecay({ ageDays: 365, halfLifeDays: 60 });
    expect(year).toBeCloseTo(trace(365), 12);
    expect(year).toBeGreaterThan(Math.exp((-Math.LN2 * 365) / 60));
  });

  it('adds the last use as its own trace, and the earlier uses spread before it', () => {
    const one = activationDecay({ ageDays: 3000, halfLifeDays: 60, uses: 1, lastUseDays: 2000 });
    expect(one).toBeCloseTo(trace(3000) + trace(2000), 12);
    const three = activationDecay({ ageDays: 3000, halfLifeDays: 60, uses: 3, lastUseDays: 2000 });
    // Two more uses, each between trace(3000) and trace(2000).
    expect(three - one).toBeGreaterThan(2 * trace(3000));
    expect(three - one).toBeLessThan(2 * trace(2000));
  });

  it('a count without a last-use time spreads over the whole life; a time without a count is one use', () => {
    const spread = activationDecay({ ageDays: 300, halfLifeDays: 60, uses: 2 });
    expect(spread).toBeGreaterThan(trace(300) + 2 * trace(300));
    expect(activationDecay({ ageDays: 300, halfLifeDays: 60, lastUseDays: 100 })).toBeCloseTo(
      trace(300) + trace(100),
      12,
    );
  });

  it('never exceeds a fresh fact, and clamps uses dated before the fact', () => {
    expect(activationDecay({ ageDays: 10, halfLifeDays: 60, uses: 50, lastUseDays: 1 })).toBe(1);
    expect(activationDecay({ ageDays: 60, halfLifeDays: 60, lastUseDays: 90 })).toBeCloseTo(
      trace(60) + trace(60),
      12,
    );
  });
});
