/**
 * How deep a captured text is read (src/documents/read-depth.ts):
 *  - noise on every question, incidental, nothing in use → raw;
 *  - worth knowing, routine → one sample; urgent, notable, in use,
 *    promoted, or untriaged → full;
 *  - urgency = a change, correction, instruction or identity at the floor.
 */
import { isUrgent, readDepth, triageFloor } from '../src/documents/read-depth';
import type { TriageStamp } from '../src/documents/triage';

const stamp = (over: Partial<TriageStamp> = {}): TriageStamp => ({
  v: 1,
  at: '2026-09-26T00:00:00Z',
  durable: 0.1,
  change: 0.1,
  instruction: 0.1,
  correction: 0.1,
  identity: 0.1,
  salience: 0,
  ...over,
});
const base = { hot: false, promoted: false, floor: 0.5 };

describe('readDepth', () => {
  it('keeps noise raw', () => {
    expect(readDepth({ ...base, stamps: [stamp()] })).toBe('raw');
  });

  it('reads a routine durable text once', () => {
    expect(readDepth({ ...base, stamps: [stamp({ durable: 0.9, salience: 1 })] })).toBe('single');
    // Routine salience alone, even with durable below the floor, is not noise.
    expect(readDepth({ ...base, stamps: [stamp({ salience: 1 })] })).toBe('single');
  });

  it('reads in full what is urgent, notable, in use, asked for or untriaged', () => {
    expect(readDepth({ ...base, stamps: [stamp({ correction: 0.7 })] })).toBe('full');
    expect(readDepth({ ...base, stamps: [stamp({ salience: 2 })] })).toBe('full');
    expect(readDepth({ ...base, hot: true, stamps: [stamp()] })).toBe('full');
    expect(readDepth({ ...base, promoted: true, stamps: [stamp()] })).toBe('full');
    expect(readDepth({ ...base, stamps: [] })).toBe('full');
    expect(readDepth({ ...base, stamps: [stamp(), undefined] })).toBe('full');
  });

  it('a group is as deep as its deepest member', () => {
    expect(readDepth({ ...base, stamps: [stamp(), stamp({ durable: 0.8 })] })).toBe('single');
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
