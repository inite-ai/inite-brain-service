/**
 * The outbound OAuth client's pure parts (W4):
 *  - the signed state binds the tenant: a forged / tampered / foreign-key
 *    state verifies to nothing before any tenant is opened;
 *  - the provider registry: an unconfigured provider resolves to null; the
 *    dev BASE_URL override swaps every origin and keeps every path, and
 *    marks the provider private; the identity pick reads the first named key;
 *  - `oauth:<grant>` is recognised as a credential pointer, nothing else is;
 *  - the callback page never carries the token / code / state, posts the
 *    result only to the origin the start named, and escapes what it shows.
 */
import { randomBytes } from 'node:crypto';
import { grantIdOfCredential } from '../src/contracts/source-plane/source-plane.schema';
import {
  pickAccount,
  providerEndpoints,
  resolveProvider,
} from '../src/source-plane/oauth/oauth-providers';
import { callbackPage } from '../src/source-plane/oauth/source-oauth-callback.controller';
import { signState, verifyState } from '../src/source-plane/oauth/source-oauth.service';

const KEY = randomBytes(32).toString('base64');

describe('signed state', () => {
  const saved = process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = saved;
  });

  it('round-trips the tenant and nonce', () => {
    const nonce = randomBytes(24).toString('base64url');
    const state = signState('co_acme', nonce);
    expect(verifyState(state)).toEqual({ companyId: 'co_acme', nonce });
  });

  it('refuses a tampered tenant, a tampered signature, garbage, and a state under another key', () => {
    const nonce = randomBytes(24).toString('base64url');
    const state = signState('co_acme', nonce);
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [, n, sig] = decoded.split('.') as [string, string, string];
    const forged = Buffer.from(`co_victim.${n}.${sig}`, 'utf8').toString('base64url');
    expect(verifyState(forged)).toBeNull();
    const flipped = Buffer.from(`co_acme.${n}.${sig.slice(1)}A`, 'utf8').toString('base64url');
    expect(verifyState(flipped)).toBeNull();
    expect(verifyState('not-a-state')).toBeNull();
    expect(verifyState('')).toBeNull();
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(verifyState(state)).toBeNull();
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = KEY;
  });
});

describe('provider registry', () => {
  it('resolves nothing without a client id, and applies the client when set', () => {
    expect(resolveProvider('google', {})).toBeNull();
    const r = resolveProvider('google', {
      SOURCE_OAUTH_GOOGLE_CLIENT_ID: 'cid',
      SOURCE_OAUTH_GOOGLE_CLIENT_SECRET: 'sec',
    });
    expect(r).toMatchObject({ clientId: 'cid', clientSecret: 'sec', private: false });
    expect(r!.authorizeUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('the dev override swaps every origin, keeps every path, and marks the provider private', () => {
    const e = providerEndpoints('dropbox', {
      SOURCE_OAUTH_DROPBOX_BASE_URL: 'http://127.0.0.1:9/',
    });
    expect(e.private).toBe(true);
    expect(e.authorizeUrl).toBe('http://127.0.0.1:9/oauth2/authorize');
    expect(e.tokenUrl).toBe('http://127.0.0.1:9/oauth2/token');
    expect(e.apiBase).toBe('http://127.0.0.1:9');
    expect(e.contentBase).toBe('http://127.0.0.1:9');
    expect(e.identity.url).toBe('http://127.0.0.1:9/2/users/get_current_account');
    const g = providerEndpoints('microsoft', { SOURCE_OAUTH_MICROSOFT_BASE_URL: 'http://h:1' });
    expect(g.apiBase).toBe('http://h:1/v1.0');
    expect(g.tokenUrl).toBe('http://h:1/common/oauth2/v2.0/token');
    expect(providerEndpoints('google', {}).private).toBe(false);
  });

  it('picks the first named identity key that is a non-empty string', () => {
    expect(pickAccount({ email: '', sub: '42' }, ['email', 'sub'])).toBe('42');
    expect(pickAccount({ userPrincipalName: 'a@b' }, ['userPrincipalName', 'mail'])).toBe('a@b');
    expect(pickAccount(null, ['email'])).toBeNull();
    expect(pickAccount({ email: 7 }, ['email'])).toBeNull();
  });
});

describe('credential pointer', () => {
  it('recognises oauth:<grant id> and nothing else', () => {
    expect(grantIdOfCredential('oauth:source_oauth_grant:abc123')).toBe(
      'source_oauth_grant:abc123',
    );
    expect(grantIdOfCredential('oauth:nonsense')).toBeNull();
    expect(grantIdOfCredential('sk-token')).toBeNull();
    expect(grantIdOfCredential(null)).toBeNull();
  });
});

describe('callback page', () => {
  it('carries the result, posts only to the named origin, and escapes', () => {
    const ok = callbackPage({
      ok: true,
      grantId: 'source_oauth_grant:g1',
      provider: 'google',
      account: '<b>o@x</b>',
      origin: 'http://localhost:3030',
    });
    expect(ok).toContain('&lt;b&gt;o@x&lt;/b&gt;');
    expect(ok).toContain('"type":"brain-source-oauth"');
    expect(ok).toContain('"http://localhost:3030"');
    expect(ok).not.toContain('</b>');
    const bad = callbackPage({ ok: false, error: 'denied </script><script>x', origin: null });
    expect(bad).not.toContain('</script><script>x');
    expect(bad).toContain('Could not connect');
    expect(bad).toContain('var origin = ""');
  });
});
