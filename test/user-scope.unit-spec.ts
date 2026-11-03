/**
 * pinUserScope — per-user memory pinning against the ALS request context.
 *
 * The guard stamps a user-bound token's end-user into the request
 * context; the pin then (a) defaults omitted userId to it, (b) 403s a
 * mismatching assertion, (c) passes caller values through untouched for
 * M2M credentials. Pure logic — no HTTP, no DB.
 */
import { ForbiddenException } from '@nestjs/common';
import { pinUserScope, userReadFence } from '../src/auth/user-scope';
import { runWithRequestContext } from '../src/common/request-context';

describe('pinUserScope', () => {
  it('passes the caller assertion through for M2M credentials (no authUserId)', () => {
    runWithRequestContext({ correlationId: 't1' }, () => {
      expect(pinUserScope('user-42')).toBe('user-42');
      expect(pinUserScope(undefined)).toBeUndefined();
    });
  });

  it('passes through outside any request context (cron, boot)', () => {
    expect(pinUserScope('user-42')).toBe('user-42');
  });

  it('defaults an omitted userId to the token end-user', () => {
    runWithRequestContext({ correlationId: 't2', authUserId: 'did:key:z6MkUser' }, () => {
      expect(pinUserScope(undefined)).toBe('did:key:z6MkUser');
    });
  });

  it('accepts a matching assertion and rejects a mismatching one (403)', () => {
    runWithRequestContext({ correlationId: 't3', authUserId: 'did:key:z6MkUser' }, () => {
      expect(pinUserScope('did:key:z6MkUser')).toBe('did:key:z6MkUser');
      expect(() => pinUserScope('did:key:z6MkOther')).toThrow(ForbiddenException);
    });
  });
});

describe('userReadFence — the knowledge_fact.userId fence of a read surface', () => {
  const saved = { read: process.env.READ_SURFACE_USER_SCOPE, tags: process.env.SCOPE_TAGS_ENABLED };
  beforeEach(() => {
    process.env.READ_SURFACE_USER_SCOPE = '1';
    process.env.SCOPE_TAGS_ENABLED = '0';
  });
  afterAll(() => {
    for (const [k, v] of [
      ['READ_SURFACE_USER_SCOPE', saved.read],
      ['SCOPE_TAGS_ENABLED', saved.tags],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('no user in play → tenant-global rows only, nothing bound', () => {
    expect(userReadFence(undefined)).toEqual({
      userId: undefined,
      clause: 'userId IS NONE',
      params: {},
    });
  });

  it('an M2M caller naming a user reads global plus that user', () => {
    expect(userReadFence('u1')).toEqual({
      userId: 'u1',
      clause: '(userId IS NONE OR userId = $scopeUserId)',
      params: { scopeUserId: 'u1' },
    });
  });

  it("a user-bound token reads its own slice even when it names no one, and never another's", () => {
    runWithRequestContext({ correlationId: 'f1', authUserId: 'u7' }, () => {
      expect(userReadFence(undefined).params).toEqual({ scopeUserId: 'u7' });
      expect(() => userReadFence('u8')).toThrow(ForbiddenException);
    });
  });

  it('with the read-surface scope switched off, a named user still reads global only', () => {
    process.env.READ_SURFACE_USER_SCOPE = '0';
    expect(userReadFence('u1')).toEqual({
      userId: undefined,
      clause: 'userId IS NONE',
      params: {},
    });
  });

  it('a credential acting in a circle and naming no user keeps its circle parameter bound', () => {
    runWithRequestContext({ correlationId: 'c1', actingCircle: 'c9' }, () => {
      const fence = userReadFence(undefined);
      expect(fence.clause).toMatch(
        /^userId IS NONE AND \(scope = \[\] OR scope ALLINSIDE \$readScopeTag\)$/,
      );
      expect(fence.params.readScopeTag).toEqual([expect.stringContaining('c9')]);
    });
  });

  it('the scope-tag fence rides along under its own parameter when on', () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    const fence = userReadFence('u1');
    expect(fence.clause).toMatch(
      /^\(userId IS NONE OR userId = \$scopeUserId\) AND \(scope = \[\] OR /,
    );
    expect(fence.params).toMatchObject({ scopeUserId: 'u1', readScopeTag: 'user:u1' });
  });
});

describe('pinUserScope — the refusal says what was refused', () => {
  it('names the mismatch, so a client knows it asked for another user', () => {
    runWithRequestContext({ correlationId: 'm1', authUserId: 'u1' }, () => {
      expect(() => pinUserScope('u2')).toThrow(/does not match the authenticated user/);
    });
  });
});
