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
