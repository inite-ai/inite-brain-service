/**
 * The end user's display name off the token (OIDC `name`): bounded like
 * userId, kept only beside a userId, mapped onto the record by both
 * verification paths, and stamped into the request context by the guard
 * — the mention path names the user's own entity with it.
 */
import { extractUserName } from '../src/auth/claim-parsers';
import { mapIntrospectionRecord } from '../src/auth/introspection.client';

describe('extractUserName', () => {
  it('keeps a bounded, non-empty string name; anything else is undefined', () => {
    expect(extractUserName({ name: ' Sasha Ivanova ' })).toBe('Sasha Ivanova');
    expect(extractUserName({ name: '' })).toBeUndefined();
    expect(extractUserName({ name: '   ' })).toBeUndefined();
    expect(extractUserName({ name: 42 })).toBeUndefined();
    expect(extractUserName({})).toBeUndefined();
    expect(extractUserName({ name: 'x'.repeat(201) })).toBeUndefined();
    expect(extractUserName({ name: 'x'.repeat(200) })).toBe('x'.repeat(200));
  });
});

describe('the introspection record', () => {
  const payload = (over: Record<string, unknown>) => ({
    active: true,
    aud: 'brain',
    scope: 'brain:read brain:write',
    ...over,
  });

  it('carries userName beside userId for a user-bound token', () => {
    const rec = mapIntrospectionRecord(
      payload({ org: 'co_x', sub: 'did:u42', name: 'Sasha' }),
      'h',
      'brain',
    );
    expect(rec).toMatchObject({ companyId: 'co_x', userId: 'did:u42', userName: 'Sasha' });
  });

  it('an M2M token has no user and therefore no user name', () => {
    const rec = mapIntrospectionRecord(payload({ sub: 'co_x', name: 'Service' }), 'h', 'brain');
    expect(rec?.userId).toBeUndefined();
    expect(rec?.userName).toBeUndefined();
  });
});
