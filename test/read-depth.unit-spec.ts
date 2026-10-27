/**
 * How deep a captured text is read (src/documents/read-depth.ts) — on
 * demand, not on arrival:
 *  - read at once, in full: urgent, notable, in use, untriaged, or asked
 *    for by an answer / beside an urgent read;
 *  - a current value of something that can change is read with one
 *    sample (the baseline a later change replaces), and so is the
 *    deferred backlog the idle budget asks for;
 *  - everything else is kept raw;
 *  - urgency = a change, correction, instruction or identity at the floor;
 *  - a run's priority maps to what asked for the read.
 */
import { PRIORITY, askOf, isUrgent, readDepth, triageFloor } from '../src/documents/read-depth';
import type { TriageStamp } from '../src/documents/triage';

const stamp = (over: Partial<TriageStamp> = {}): TriageStamp => ({
  v: 1,
  at: '2026-09-26T00:00:00Z',
  durable: 0.1,
  change: 0.1,
  instruction: 0.1,
  correction: 0.1,
  identity: 0.1,
  state: 0.1,
  salience: 0,
  ...over,
});
const base = { hot: false, asked: undefined, floor: 0.5 };

describe('readDepth', () => {
  it('keeps raw what nothing asks for: noise, and routine durable text alike', () => {
    expect(readDepth({ ...base, stamps: [stamp()] })).toBe('raw');
    expect(readDepth({ ...base, stamps: [stamp({ durable: 0.9, salience: 1 })] })).toBe('raw');
  });

  it('reads a current value of something that can change with one sample — the baseline', () => {
    expect(readDepth({ ...base, stamps: [stamp({ durable: 0.9, state: 0.8, salience: 1 })] })).toBe(
      'single',
    );
  });

  it('reads the deferred backlog with one sample when the idle budget asks', () => {
    expect(
      readDepth({ ...base, asked: 'idle', stamps: [stamp({ durable: 0.9, salience: 1 })] }),
    ).toBe('single');
  });

  it('reads in full, at once, what is urgent, notable, in use, untriaged or asked for', () => {
    expect(readDepth({ ...base, stamps: [stamp({ correction: 0.7 })] })).toBe('full');
    expect(readDepth({ ...base, stamps: [stamp({ salience: 2 })] })).toBe('full');
    expect(readDepth({ ...base, hot: true, stamps: [stamp()] })).toBe('full');
    expect(readDepth({ ...base, asked: 'answer', stamps: [stamp()] })).toBe('full');
    expect(readDepth({ ...base, stamps: [] })).toBe('full');
    expect(readDepth({ ...base, stamps: [stamp(), undefined] })).toBe('full');
  });

  it('a group is as deep as its deepest member', () => {
    expect(readDepth({ ...base, stamps: [stamp(), stamp({ durable: 0.8 })] })).toBe('raw');
    expect(readDepth({ ...base, stamps: [stamp(), stamp({ identity: 0.9 })] })).toBe('full');
  });
});

describe('isUrgent', () => {
  it('is a change, correction, instruction or identity at the floor — not durable or salience', () => {
    for (const k of ['change', 'correction', 'instruction', 'identity'] as const) {
      expect(isUrgent([stamp({ [k]: 0.5 })], 0.5)).toBe(true);
    }
    expect(isUrgent([stamp({ durable: 0.99, salience: 3 })], 0.5)).toBe(false);
    expect(isUrgent([undefined], 0.5)).toBe(false);
  });
});

describe('askOf', () => {
  it('maps a run priority to what asked for the read', () => {
    expect(askOf(0)).toBeUndefined();
    expect(askOf(PRIORITY.idle)).toBe('idle');
    expect(askOf(PRIORITY.answer)).toBe('answer');
  });
});

describe('triageFloor', () => {
  afterEach(() => delete process.env.EXTRACTION_TRIAGE_FLOOR);
  it('defaults to the decision boundary and accepts a probability', () => {
    expect(triageFloor()).toBe(0.5);
    process.env.EXTRACTION_TRIAGE_FLOOR = '0.3';
    expect(triageFloor()).toBe(0.3);
    process.env.EXTRACTION_TRIAGE_FLOOR = '1.5';
    expect(triageFloor()).toBe(0.5);
  });
});
