/**
 * Truth discovery (#847): claim posteriors and source accuracies fitted
 * together. The battery (`pnpm eval:truth-discovery`) measures it at
 * scale; these pin the rules that make it right.
 */
import { discoverTruth, type TruthFact } from '../src/ai/calibration/truth-discovery';
import { simulate } from './eval/truth-discovery/simulate';
import { score } from './eval/truth-discovery/score';

const DAY = 86_400_000;
let n = 0;
function fact(over: Partial<TruthFact> & Pick<TruthFact, 'claim' | 'sourceKey'>): TruthFact {
  const id = `f${n++}`;
  return {
    factId: id,
    slot: 'maria/lives_in',
    domain: 'lives_in',
    origin: `o-${id}`,
    validFrom: 0,
    validUntil: null,
    ...over,
  };
}
const posteriorOf = (r: ReturnType<typeof discoverTruth>, id: string) =>
  r.facts.find((f) => f.factId === id)?.posterior;

describe('truth discovery — what competes', () => {
  it('values that succeed each other in valid time are not rivals, so reporting a change costs nothing', () => {
    const old = fact({ claim: 'lisbon', sourceKey: 'crm:_', validFrom: 0, validUntil: 10 * DAY });
    const now = fact({ claim: 'porto', sourceKey: 'crm:_', validFrom: 10 * DAY });
    const r = discoverTruth([old, now], [], { priorStrength: 4 });
    expect(r.facts).toEqual([]);
    expect(r.sources).toEqual([]);
  });

  it('overlapping values that differ are a contest whose posteriors sum to one', () => {
    const a = fact({ claim: 'lisbon', sourceKey: 'crm:_' });
    const b = fact({ claim: 'porto', sourceKey: 'chat:ana' });
    const r = discoverTruth([a, b], [], { priorStrength: 4 });
    expect(posteriorOf(r, a.factId)! + posteriorOf(r, b.factId)!).toBeCloseTo(1, 9);
    expect(r.facts.every((f) => f.claims === 2)).toBe(true);
  });

  it('a value closed the instant it began still claimed that instant: its replacement is its rival', () => {
    // single_active: a same-time write from another source closes the old
    // value at its own validFrom. The two still disagree about that moment.
    const replaced = fact({ claim: 'gold', sourceKey: 'crm:_', validFrom: DAY, validUntil: DAY });
    const later = fact({ claim: 'silver', sourceKey: 'chat:ana', validFrom: DAY });
    const r = discoverTruth([replaced, later], [], { priorStrength: 4 });
    expect(r.facts.map((f) => f.claims)).toEqual([2, 2]);
  });

  it('a lone uncontested value says nothing about anyone; two origins agreeing count as agreement', () => {
    const lone = discoverTruth([fact({ claim: 'lisbon', sourceKey: 'crm:_' })], [], {
      priorStrength: 4,
    });
    expect(lone.facts).toEqual([]);
    const agreed = discoverTruth(
      [
        fact({ claim: 'lisbon', sourceKey: 'crm:_' }),
        fact({ claim: 'lisbon', sourceKey: 'chat:ana' }),
      ],
      [],
      { priorStrength: 4 },
    );
    expect(agreed.facts.map((f) => [f.claims, f.posterior])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    // Both sources named the (only) value: above the 0.5 prior.
    expect(agreed.sources.filter((s) => s.domain === null).every((s) => s.accuracy > 0.5)).toBe(
      true,
    );
  });

  it('copies of one origin are one vote: two copiers cannot outvote an independent source', () => {
    const origin = 'doc:abc';
    const facts = [
      fact({ claim: 'porto', sourceKey: 'mail:x', origin }),
      fact({ claim: 'porto', sourceKey: 'mail:y', origin }),
      fact({ claim: 'porto', sourceKey: 'mail:z', origin }),
      fact({ claim: 'lisbon', sourceKey: 'crm:_' }),
    ];
    const r = discoverTruth(facts, [], { priorStrength: 4 });
    expect(posteriorOf(r, facts[0]!.factId)).toBeCloseTo(0.5, 6);
  });
});

describe('truth discovery — anchors', () => {
  it('a confirmed value takes the whole posterior; a rejected one none', () => {
    const a = fact({ claim: 'lisbon', sourceKey: 'crm:_' });
    const b = fact({ claim: 'porto', sourceKey: 'chat:ana' });
    const c = fact({ claim: 'faro', sourceKey: 'chat:bo' });
    const confirmed = discoverTruth([a, b, c], [{ factId: b.factId, correct: true }], {
      priorStrength: 4,
    });
    expect(posteriorOf(confirmed, b.factId)).toBe(1);
    const rejected = discoverTruth([a, b, c], [{ factId: b.factId, correct: false }], {
      priorStrength: 4,
    });
    expect(posteriorOf(rejected, b.factId)).toBe(0);
    expect(posteriorOf(rejected, a.factId)! + posteriorOf(rejected, c.factId)!).toBeCloseTo(1, 9);
  });

  it('a retracted value is clamped false; humans who disagree leave a claim free', () => {
    const a = fact({ claim: 'lisbon', sourceKey: 'crm:_', retracted: true });
    const b = fact({ claim: 'porto', sourceKey: 'chat:ana' });
    expect(posteriorOf(discoverTruth([a, b], [], { priorStrength: 4 }), b.factId)).toBe(1);
    const split = discoverTruth(
      [fact({ ...b, factId: 'x1', claim: 'porto' }), fact({ claim: 'faro', sourceKey: 'chat:bo' })],
      [
        { factId: 'x1', correct: true },
        { factId: 'x1', correct: false },
      ],
      { priorStrength: 4 },
    );
    expect(posteriorOf(split, 'x1')).toBeCloseTo(0.5, 6);
  });

  it('feedback moves the source: a source a user keeps rejecting loses accuracy', () => {
    const facts: TruthFact[] = [];
    const anchors = [];
    for (let i = 0; i < 6; i++) {
      const bad = fact({ slot: `s${i}`, claim: 'wrong', sourceKey: 'voice:_' });
      facts.push(bad, fact({ slot: `s${i}`, claim: 'right', sourceKey: 'crm:_' }));
      anchors.push({ factId: bad.factId, correct: false });
    }
    const r = discoverTruth(facts, anchors, { priorStrength: 4 });
    const acc = (k: string) =>
      r.sources.find((s) => s.sourceKey === k && s.domain === null)!.accuracy;
    expect(acc('voice:_')).toBeLessThan(0.5);
    expect(acc('crm:_')).toBeGreaterThan(0.5);
  });
});

describe('truth discovery — priors', () => {
  it('a declared authority is the prior mean; evidence moves it, strength bounds how fast', () => {
    const a = fact({ claim: 'lisbon', sourceKey: 'crm:_' });
    const b = fact({ claim: 'porto', sourceKey: 'chat:ana' });
    const r = discoverTruth([a, b], [], {
      priorStrength: 4,
      declared: new Map([['crm:_', 0.9]]),
    });
    expect(posteriorOf(r, a.factId)!).toBeGreaterThan(0.75);
  });

  it('a domain accuracy shrinks towards the source across domains, not towards 0.5', () => {
    const facts: TruthFact[] = [];
    for (let i = 0; i < 20; i++) {
      facts.push(
        fact({ slot: `a${i}`, domain: 'title', claim: 'x', sourceKey: 'crm:_' }),
        fact({ slot: `a${i}`, domain: 'title', claim: 'x', sourceKey: 'hr:_' }),
      );
    }
    // One vote in a new domain.
    facts.push(
      fact({ slot: 'b', domain: 'city', claim: 'x', sourceKey: 'crm:_' }),
      fact({ slot: 'b', domain: 'city', claim: 'x', sourceKey: 'hr:_' }),
    );
    const r = discoverTruth(facts, [], { priorStrength: 4 });
    const city = r.sources.find((s) => s.sourceKey === 'crm:_' && s.domain === 'city')!;
    const global = r.sources.find((s) => s.sourceKey === 'crm:_' && s.domain === null)!;
    expect(city.accuracy).toBeGreaterThan(0.85);
    expect(Math.abs(city.accuracy - global.accuracy)).toBeLessThan(0.05);
  });
});

describe('truth discovery — on a synthetic workspace of known truth', () => {
  const ws = simulate({ seed: 7, slots: 300, values: 4, anchorRate: 0.05 });
  const s = score(ws, 16);

  it('picks the true value more often than majority vote', () => {
    expect(s.slots).toBeGreaterThan(100);
    expect(s.accuracy.truthDiscovery).toBeGreaterThan(s.accuracy.majority + 0.03);
  });

  it('is calibrated: a stated 0.8 is right about 80% of the time', () => {
    expect(s.ece).toBeLessThan(0.06);
  });

  it('recovers source accuracies far better than the win/loss tally', () => {
    expect(s.sourceRmse.truthDiscovery).toBeLessThan(0.08);
    expect(s.sourceRmse.winRate).toBeGreaterThan(0.2);
  });

  it('a source that reports changes and is never wrong is not scored as unreliable', () => {
    expect(s.diligent.truthDiscovery).toBeGreaterThan(0.85);
    expect(s.diligent.winRate).toBeLessThan(0.5);
  });

  it('is deterministic', () => {
    const again = discoverTruth(ws.facts, ws.anchors, { priorStrength: 16 });
    expect(again).toEqual(discoverTruth(ws.facts, ws.anchors, { priorStrength: 16 }));
  });
});
