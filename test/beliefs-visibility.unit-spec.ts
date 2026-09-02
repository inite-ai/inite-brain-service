/**
 * Pure-verdict unit coverage of the belief read fence (the factVisible
 * idiom): beliefVisible is the ONE visibility implementation both
 * GET /v1/beliefs/:id and the list's JS re-filter apply — pinned here so
 * the fail-closed semantics can never drift silently.
 */
import {
  beliefVisible,
  BELIEFS_LIST_DEFAULT,
  BELIEFS_LIST_MAX,
} from '../src/beliefs/beliefs.service';

describe('beliefVisible (fail-closed single-user fence)', () => {
  it('M2M (no pinned user) sees any well-stamped belief', () => {
    expect(beliefVisible({ userId: 'u1' }, undefined)).toBe(true);
    expect(beliefVisible({ userId: 'u2' }, undefined)).toBe(true);
  });

  it('a user-bound token sees only its OWN beliefs', () => {
    expect(beliefVisible({ userId: 'u1' }, 'u1')).toBe(true);
    expect(beliefVisible({ userId: 'u2' }, 'u1')).toBe(false);
  });

  it('an out-of-contract stamp is invisible to EVERYONE — M2M included', () => {
    // The promotion never writes these (#387 fence); if such a row ever
    // exists it must serve to no caller, fail-closed.
    for (const userId of ['', undefined, null, 42, ['u1']]) {
      expect(beliefVisible({ userId }, undefined)).toBe(false);
      expect(beliefVisible({ userId }, 'u1')).toBe(false);
    }
  });
});

describe('belief list caps', () => {
  it('pins the page constants the controller clamps against', () => {
    expect(BELIEFS_LIST_DEFAULT).toBe(25);
    expect(BELIEFS_LIST_MAX).toBe(100);
  });
});
