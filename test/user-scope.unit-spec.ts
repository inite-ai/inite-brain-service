/**
 * pinUserScope — per-user memory pinning against the ALS request context.
 *
 * The guard stamps a user-bound token's end-user into the request
 * context; the pin then (a) defaults omitted userId to it, (b) 403s a
 * mismatching assertion, (c) passes caller values through untouched for
 * M2M credentials. Pure logic — no HTTP, no DB.
 */
import { ForbiddenException } from '@nestjs/common';
import { pinUserScope } from '../src/auth/user-scope';
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
