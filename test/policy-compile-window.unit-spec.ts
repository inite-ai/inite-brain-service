import { compilePolicySet } from '../src/policy/policy-compile';
import { PolicyDocumentSchema } from '../src/policy/policy.types';

const doc = (over: Record<string, unknown> = {}) =>
  PolicyDocumentSchema.parse({
    name: 'windowed-set',
    posture: { actions: 'deny', reads: 'deny' },
    mode: 'enforce',
    rules: [],
    ...over,
  });

describe('compilePolicySet temporal windows', () => {
  const now = new Date('2026-07-09T12:00:00Z');

  it('compiles inside the window and with no window', () => {
    expect(compilePolicySet(doc(), now)).not.toBeNull();
    expect(
      compilePolicySet(
        doc({
          activeFrom: '2026-07-01T00:00:00Z',
          activeUntil: '2026-08-01T00:00:00Z',
        }),
        now,
      ),
    ).not.toBeNull();
  });

  it('returns null before activeFrom and at/after activeUntil', () => {
    expect(
      compilePolicySet(doc({ activeFrom: '2026-07-10T00:00:00Z' }), now),
    ).toBeNull();
    expect(
      compilePolicySet(doc({ activeUntil: '2026-07-09T12:00:00Z' }), now),
    ).toBeNull();
    expect(
      compilePolicySet(doc({ activeUntil: '2026-07-01T00:00:00Z' }), now),
    ).toBeNull();
  });

  it('open-ended bounds behave as half-infinite windows', () => {
    expect(
      compilePolicySet(doc({ activeFrom: '2026-01-01T00:00:00Z' }), now),
    ).not.toBeNull();
    expect(
      compilePolicySet(doc({ activeUntil: '2027-01-01T00:00:00Z' }), now),
    ).not.toBeNull();
  });
});

describe('PolicyDocumentSchema window validation', () => {
  const parse = (over: Record<string, unknown>) =>
    PolicyDocumentSchema.parse({
      name: 'windowed-set',
      posture: { actions: 'deny', reads: 'deny' },
      mode: 'enforce',
      rules: [],
      ...over,
    });

  it('rejects a window that can never open (activeFrom >= activeUntil)', () => {
    // Inverted — the set would be permanently inert (fail-open), a mistake.
    expect(() =>
      parse({
        activeFrom: '2026-08-01T00:00:00Z',
        activeUntil: '2026-07-01T00:00:00Z',
      }),
    ).toThrow(/activeFrom must be strictly before activeUntil/);
    // Equal bounds are also a dead window.
    expect(() =>
      parse({
        activeFrom: '2026-07-01T00:00:00Z',
        activeUntil: '2026-07-01T00:00:00Z',
      }),
    ).toThrow(/activeFrom must be strictly before activeUntil/);
  });

  it('accepts a valid window and open-ended bounds', () => {
    expect(() =>
      parse({
        activeFrom: '2026-07-01T00:00:00Z',
        activeUntil: '2026-08-01T00:00:00Z',
      }),
    ).not.toThrow();
    expect(() => parse({ activeFrom: '2026-07-01T00:00:00Z' })).not.toThrow();
    expect(() => parse({ activeUntil: '2026-08-01T00:00:00Z' })).not.toThrow();
  });
});
