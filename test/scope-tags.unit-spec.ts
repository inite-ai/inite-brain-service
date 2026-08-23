/**
 * G6 scope-tag foundation — grammar + visibility evaluator + principal
 * derivation + SQL-fence unit coverage (steps 1-2 of
 * docs/roadmap/sota-gap-build-2026-08.md).
 *
 * The evaluator is a SECURITY fence: the truth table below pins the
 * fail-closed behavior (unparseable / unknown-namespace / non-matching
 * → hidden) and the tenant-wide (M2M) sees-all behavior that the
 * flag-on parity property rests on.
 */
import { KNOWN_NAMESPACES, parseTag, scopeForUser, userTag } from '../src/auth/scope-tags';
import {
  TENANT_WIDE,
  principalScopeTags,
  scopeFenceSql,
  scopeTagsEnabled,
  visibleUnderScope,
} from '../src/auth/scope-visibility';
import { runWithRequestContext } from '../src/common/request-context';

describe('scope-tags grammar', () => {
  it('userTag builds user:<id>', () => {
    expect(userTag('bob')).toBe('user:bob');
    expect(userTag('u_42:x')).toBe('user:u_42:x');
  });

  it('scopeForUser maps userId → one-clause AND-set, undefined → global', () => {
    expect(scopeForUser('bob')).toEqual(['user:bob']);
    expect(scopeForUser(undefined)).toEqual([]);
  });

  describe('parseTag', () => {
    it('parses the active user namespace', () => {
      expect(parseTag('user:bob')).toEqual({ namespace: 'user', id: 'bob' });
    });

    it('accepts the reserved org/team namespaces (step 3+)', () => {
      expect(parseTag('org:acme')).toEqual({ namespace: 'org', id: 'acme' });
      expect(parseTag('team:blue')).toEqual({ namespace: 'team', id: 'blue' });
      expect(KNOWN_NAMESPACES.has('org')).toBe(true);
      expect(KNOWN_NAMESPACES.has('team')).toBe(true);
    });

    it('keeps colons inside the id (record ids)', () => {
      expect(parseTag('user:knowledge_entity:abc')).toEqual({
        namespace: 'user',
        id: 'knowledge_entity:abc',
      });
    });

    it('fails closed on malformed or unknown-namespace tags', () => {
      expect(parseTag('bob')).toBeNull(); // no separator
      expect(parseTag(':bob')).toBeNull(); // empty namespace
      expect(parseTag('user:')).toBeNull(); // empty id
      expect(parseTag('evil:bob')).toBeNull(); // unknown namespace
      expect(parseTag('')).toBeNull();
      expect(parseTag('USER:bob')).toBeNull(); // case-sensitive
    });
  });
});

describe('visibleUnderScope — evaluator truth table', () => {
  const A = ['user:a'];
  const B = ['user:b'];

  it('empty record scope is tenant-global → visible to everyone', () => {
    expect(visibleUnderScope([], A)).toBe(true);
    expect(visibleUnderScope([], B)).toBe(true);
    expect(visibleUnderScope([], TENANT_WIDE)).toBe(true);
  });

  it('a matching single tag is visible to its principal', () => {
    expect(visibleUnderScope(['user:a'], A)).toBe(true);
  });

  it('a non-matching single tag is hidden', () => {
    expect(visibleUnderScope(['user:a'], B)).toBe(false);
    expect(visibleUnderScope(['user:b'], A)).toBe(false);
  });

  it('fails closed on an unparseable / unknown-namespace record tag', () => {
    expect(visibleUnderScope(['evil:a'], A)).toBe(false);
    expect(visibleUnderScope(['garbage'], A)).toBe(false);
    expect(visibleUnderScope(['user:'], A)).toBe(false);
    // Even a record that also carries the principal's valid tag is hidden
    // if ANY tag in the AND-set is unparseable.
    expect(visibleUnderScope(['user:a', 'evil:x'], A)).toBe(false);
  });

  it('a tenant-wide (M2M) principal sees everything, including malformed', () => {
    expect(visibleUnderScope(['user:a'], TENANT_WIDE)).toBe(true);
    expect(visibleUnderScope(['user:b'], TENANT_WIDE)).toBe(true);
    expect(visibleUnderScope(['evil:x'], TENANT_WIDE)).toBe(true);
  });

  it('a multi-tag AND-set clause requires ALL its tags', () => {
    const AB = ['user:a', 'org:acme'];
    // Principal holds only user:a → does not satisfy the full AND-set.
    expect(visibleUnderScope(AB, ['user:a'])).toBe(false);
    // Principal holds both tags → satisfied.
    expect(visibleUnderScope(AB, ['user:a', 'org:acme'])).toBe(true);
    // Extra principal tags are fine (superset satisfies the clause).
    expect(visibleUnderScope(['user:a'], ['user:a', 'org:acme'])).toBe(true);
  });
});

describe('principalScopeTags — request-context derivation', () => {
  it('a user-bound token → ["user:<authUserId>"]', () => {
    const tags = runWithRequestContext({ correlationId: 'c1', authUserId: 'user_a' }, () =>
      principalScopeTags(),
    );
    expect(tags).toEqual(['user:user_a']);
  });

  it('an M2M credential (no authUserId) → TENANT_WIDE', () => {
    const tags = runWithRequestContext({ correlationId: 'c2' }, () => principalScopeTags());
    expect(tags).toBe(TENANT_WIDE);
  });

  it('a background context (no request context) → TENANT_WIDE', () => {
    expect(principalScopeTags()).toBe(TENANT_WIDE);
  });
});

describe('scopeFenceSql — flag-gated SQL mirror of the userId filter', () => {
  const saved = process.env.SCOPE_TAGS_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCOPE_TAGS_ENABLED;
    else process.env.SCOPE_TAGS_ENABLED = saved;
  });

  it('is fully inert when the flag is off', () => {
    delete process.env.SCOPE_TAGS_ENABLED;
    expect(scopeTagsEnabled()).toBe(false);
    expect(scopeFenceSql('user_a')).toEqual({ clause: '', params: {} });
    expect(scopeFenceSql(undefined)).toEqual({ clause: '', params: {} });
  });

  it('mirrors the userId filter tag-for-tag when on', () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    expect(scopeTagsEnabled()).toBe(true);
    // Scoped user → global OR own tag.
    expect(scopeFenceSql('user_a')).toEqual({
      clause: 'AND (scope = [] OR scope = [$principalScopeTag])',
      params: { principalScopeTag: 'user:user_a' },
    });
    // No scoped user → tenant-global only (mirrors `userId IS NONE`).
    expect(scopeFenceSql(undefined)).toEqual({
      clause: 'AND scope = []',
      params: {},
    });
  });

  it('honors a custom bound-parameter name', () => {
    process.env.SCOPE_TAGS_ENABLED = 'true';
    expect(scopeFenceSql('user_a', 'pTag')).toEqual({
      clause: 'AND (scope = [] OR scope = [$pTag])',
      params: { pTag: 'user:user_a' },
    });
  });
});
