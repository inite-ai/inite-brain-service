/**
 * eval:affect's scorer (test/eval/affect/runner.ts) on a tiny fixture: a
 * reading counts only through the reader's parser, traps are tallied, and
 * calibration bins what was read.
 */
import { scoreAffect } from './eval/affect/runner';

const turns = [
  { handle: 't1', speaker: 'Ana', own: true, text: 'I dread Friday.', occurredAt: 'x' },
  { handle: 't2', speaker: 'Ana', own: true, text: 'Thanks!', occurredAt: 'x' },
];
const request = {
  id: 'r1',
  lang: 'en',
  system: '',
  user: '',
  turns,
  gold: [
    { handle: 't1', gold: ['fear' as const] },
    { handle: 't2', gold: [], trap: 'formula' },
  ],
};
const obs = (o: Record<string, unknown>) => ({
  turn: 't1',
  quote: 'dread Friday',
  valence: -0.6,
  label: 'fear',
  target: null,
  confidence: 0.8,
  ...o,
});

describe('scoreAffect', () => {
  it('a correct reading and a kept silence score perfectly', () => {
    const s = scoreAffect('t', [request], new Map([['r1', { observations: [obs({})] }]]));
    expect(s.detection).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(s.labelAccuracy).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
    expect(s.falsePositivesByTrap).toEqual({ formula: { turns: 1, falsePositives: 0 } });
  });

  it('a reading of the formula is a trap false positive; a made-up quote is no reading', () => {
    const s = scoreAffect(
      't',
      [request],
      new Map([
        [
          'r1',
          {
            observations: [
              obs({ quote: 'not in the turn' }),
              obs({ turn: 't2', quote: 'Thanks!', label: 'joy', valence: 0.5 }),
            ],
          },
        ],
      ]),
    );
    expect(s.droppedByParser).toBe(1);
    expect(s.detection.recall).toBe(0);
    expect(s.falsePositiveRate).toBe(1);
    expect(s.falsePositivesByTrap.formula).toEqual({ turns: 1, falsePositives: 1 });
    expect(s.reliability).toEqual([{ bin: '0.8–0.9', n: 1, meanConfidence: 0.8, accuracy: 0 }]);
  });
});
