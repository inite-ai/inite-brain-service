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
  accountHostOf,
  fillHost,
  identityUrl,
  pickAccount,
  providerEndpoints,
  providerSpec,
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

/**
 * A vendor on the account's own host (W4.3b): Kommo's token endpoint
 * and API live at `<subdomain>.kommo.com`, named by the callback;
 * Bitrix24's REST at the portal the token response named. The URL
 * templates carry `{host}`; the login-host override leaves them alone,
 * the dev override reroutes them like any other, and a callback naming
 * a host outside the vendor is refused — the app's secret goes there.
 */
describe('a provider on the account host', () => {
  it('the templates are filled from the account host; the login-host override leaves them alone; the dev override reroutes them', () => {
    const kommo = providerSpec('kommo');
    expect(fillHost(kommo.tokenUrl, 'acme.kommo.com')).toBe(
      'https://acme.kommo.com/oauth2/access_token',
    );
    expect(() => fillHost(kommo.tokenUrl, null)).toThrow(/account host/);
    expect(fillHost(providerSpec('google').tokenUrl, null)).toBe(
      'https://oauth2.googleapis.com/token',
    );
    const amo = providerEndpoints('kommo', {
      SOURCE_OAUTH_KOMMO_LOGIN_URL: 'https://www.amocrm.ru',
    } as NodeJS.ProcessEnv);
    expect(amo.authorizeUrl).toBe('https://www.amocrm.ru/oauth');
    expect(amo.tokenUrl).toBe('https://{host}/oauth2/access_token');
    expect(amo.identity.url).toBe('https://{host}/api/v4/account');
    const fake = providerEndpoints('kommo', {
      SOURCE_OAUTH_KOMMO_BASE_URL: 'http://127.0.0.1:4545',
    } as NodeJS.ProcessEnv);
    expect(fake.tokenUrl).toBe('http://127.0.0.1:4545/oauth2/access_token');
    expect(fake.identity.url).toBe('http://127.0.0.1:4545/api/v4/account');
    expect(fake.private).toBe(true);
    const portal = providerEndpoints('bitrix24', {
      SOURCE_OAUTH_BITRIX24_LOGIN_URL: 'https://acme.bitrix24.ru',
    } as NodeJS.ProcessEnv);
    expect(portal.authorizeUrl).toBe('https://acme.bitrix24.ru/oauth/authorize/');
    expect(portal.tokenUrl).toBe('https://acme.bitrix24.ru/oauth/token/');
    expect(portal.identity.url).toBe('https://{host}/rest/profile.json');
  });

  it('the identity URL takes the account host; without one a templated URL cannot be built', () => {
    const kommo = providerSpec('kommo');
    expect(identityUrl(kommo, 'tok', { accountHost: 'acme.kommo.com' })).toBe(
      'https://acme.kommo.com/api/v4/account',
    );
    expect(() => identityUrl(kommo, 'tok', { accountHost: null })).toThrow(/account host/);
    expect(identityUrl(providerSpec('bitrix24'), 'tok', { accountHost: 'acme.bitrix24.ru' })).toBe(
      'https://acme.bitrix24.ru/rest/profile.json',
    );
  });

  it('the callback host is accepted under the vendor’s suffixes only, as a bare hostname; anything else is refused by name', () => {
    const kommo = providerSpec('kommo');
    expect(accountHostOf(kommo, { referer: 'Acme.kommo.com' })).toBe('acme.kommo.com');
    expect(accountHostOf(kommo, { referer: 'acme.amocrm.ru' })).toBe('acme.amocrm.ru');
    expect(() => accountHostOf(kommo, { referer: 'evil.example.com' })).toThrow(/outside Kommo/);
    expect(() => accountHostOf(kommo, { referer: 'acme.kommo.com.evil.example' })).toThrow(
      /outside Kommo/,
    );
    expect(() => accountHostOf(kommo, { referer: 'https://acme.kommo.com/x' })).toThrow(
      /names no account host/,
    );
    expect(() => accountHostOf(kommo, {})).toThrow(/names no account host/);
    // Under the dev override the token URL is rerouted anyway: any hostname passes.
    expect(accountHostOf({ ...kommo, private: true }, { referer: '127.0.0.1:4545' })).toBe(
      '127.0.0.1:4545',
    );
    // A provider without the parameter has no host to take.
    expect(accountHostOf(providerSpec('bitrix24'), { domain: 'acme.bitrix24.ru' })).toBeNull();
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
