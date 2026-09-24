/**
 * The membership plane's pure parts (W5, G6 step 3): the team-tag
 * grammar, the scope one source write belongs to, the ambient write
 * scope, and the multi-tag read fence.
 */
import { runWithWriteScope } from '../src/auth/write-scope';
import { parseTeamTag, scopeForSource, scopeForUser, teamTag } from '../src/auth/scope-tags';
import { scopeFenceSql, visibleUnderScope, TENANT_WIDE } from '../src/auth/scope-visibility';
import { rememberScopeTags } from '../src/auth/scope-principal';
import { runWithRequestContext } from '../src/common/request-context';

const CONN = 'source_connection:abc';

describe('team tags', () => {
  it('a team tag carries its connection, and a half-formed one parses as nothing', () => {
    // ⚡The record id's TAIL, because a record id has a colon in it and
    // a tag with two variable colon-separated parts cannot be parsed.
    expect(teamTag(CONN, 'members')).toBe('team:abc:members');
    expect(parseTeamTag(teamTag(CONN, 'members'))).toEqual({
      connection: 'abc',
      group: 'members',
    });
    // A group whose own name has colons keeps them: only the first
    // colon, the connection's, is a separator.
    expect(parseTeamTag('team:c:a:b')).toEqual({ connection: 'c', group: 'a:b' });
    expect(parseTeamTag('team:members')).toBeNull();
    expect(parseTeamTag('user:u1')).toBeNull();
    expect(parseTeamTag('nonsense')).toBeNull();
  });

  it('a source write is the owner’s, else its groups, else tenant-global', () => {
    expect(scopeForSource({ userId: 'u1', connectionId: CONN, groups: ['members'] })).toEqual([
      'user:u1',
    ]);
    expect(scopeForSource({ connectionId: CONN, groups: ['members'] })).toEqual([
      'team:abc:members',
    ]);
    expect(scopeForSource({ connectionId: CONN, groups: [] })).toEqual([]);
    expect(scopeForSource({ connectionId: CONN })).toEqual([]);
  });
});

describe('the ambient write scope', () => {
  it('fills a tenant-global write and never widens a user’s', () => {
    expect(scopeForUser(undefined)).toEqual([]);
    runWithWriteScope([teamTag(CONN, 'members')], () => {
      expect(scopeForUser(undefined)).toEqual([teamTag(CONN, 'members')]);
      // A write attributed to a person stays that person's, whatever
      // span it happens inside.
      expect(scopeForUser('u1')).toEqual(['user:u1']);
    });
    // And it does not leak out of its span.
    expect(scopeForUser(undefined)).toEqual([]);
  });

  it('an empty declared scope is no span at all', () => {
    runWithWriteScope([], () => expect(scopeForUser(undefined)).toEqual([]));
  });
});

describe('the read fence with group tags', () => {
  const ctx = () => ({ correlationId: 'c1' });

  it('one tag keeps the step-1 equality; several become a subset test', () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    try {
      const single = scopeFenceSql('u1');
      expect(single.clause).toContain('scope = [$principalScopeTag]');
      expect(single.params).toEqual({ principalScopeTag: 'user:u1' });

      runWithRequestContext(ctx(), () => {
        rememberScopeTags('u1', ['user:u1', teamTag(CONN, 'members')]);
        const many = scopeFenceSql('u1');
        expect(many.clause).toContain('scope ALLINSIDE $principalScopeTag');
        expect(many.params).toEqual({
          principalScopeTag: ['user:u1', teamTag(CONN, 'members')],
        });
      });
    } finally {
      delete process.env.SCOPE_TAGS_ENABLED;
    }
  });

  it('the fence is inert while the flag is off', () => {
    delete process.env.SCOPE_TAGS_ENABLED;
    expect(scopeFenceSql('u1')).toEqual({ clause: '', params: {} });
  });

  it('a principal holding a group sees the group’s rows, and nobody else’s', () => {
    const held = ['user:u1', teamTag(CONN, 'members')];
    expect(visibleUnderScope([teamTag(CONN, 'members')], held)).toBe(true);
    expect(visibleUnderScope([teamTag(CONN, 'secret')], held)).toBe(false);
    expect(visibleUnderScope([], held)).toBe(true);
    // Fail closed: a tag of an unknown namespace hides its row from a
    // scoped principal even when the principal "holds" that string.
    expect(visibleUnderScope(['cabal:x'], ['cabal:x'])).toBe(false);
    // …and tenant-wide authority is the tenant boundary itself.
    expect(visibleUnderScope(['cabal:x'], TENANT_WIDE)).toBe(true);
  });
});
