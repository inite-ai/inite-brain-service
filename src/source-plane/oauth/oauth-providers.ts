/**
 * The OAuth providers the brain can be a client of (raw-evidence-
 * sources-2026-09.md W4) — platform code, one entry per identity
 * provider, the way connectors are platform code: a pack names a
 * connector, the connector names its provider and scopes, and nothing
 * outside this file knows an authorize URL.
 *
 * Per provider the operator sets SOURCE_OAUTH_<PROVIDER>_CLIENT_ID and
 * _CLIENT_SECRET (the app registered at the provider, with the brain's
 * callback URL as its redirect URI); unset = the provider is "not
 * configured" and the catalogue says so. SOURCE_OAUTH_<PROVIDER>_BASE_URL
 * is a dev/test override that points EVERY one of the provider's URLs
 * (authorize, token, identity, API) at one origin — a fake provider on
 * loopback — and is honoured only together with the operator's
 * private-egress opt-in; unset in production, the public hosts below
 * are the only ones ever contacted.
 *
 * Every provider here speaks the authorization-code grant with PKCE
 * (S256) and returns a refresh token when asked the provider's way
 * (`access_type=offline` / `token_access_type=offline` /
 * `offline_access`), so a connection keeps syncing after the hour the
 * access token lives.
 */

export type OAuthProviderId =
  'google' | 'microsoft' | 'dropbox' | 'pipedrive' | 'hubspot' | 'salesforce';

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = [
  'google',
  'microsoft',
  'dropbox',
  'pipedrive',
  'hubspot',
  'salesforce',
];

export interface OAuthProviderSpec {
  id: OAuthProviderId;
  title: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** How the client authenticates at the token endpoint: in the form body (default), HTTP Basic (Pipedrive), or not at all (a public PKCE client). */
  tokenAuth?: 'body' | 'basic' | 'none' | undefined;
  /** Provider-specific authorize parameters (offline access, consent). */
  authorizeParams: Record<string, string>;
  /** Scopes every grant of this provider carries (identity), beyond what a connector asks. */
  baseScopes: string[];
  /** The API origin the connectors talk to. */
  apiBase: string;
  /** A second origin for bytes (Dropbox serves content from its own host). */
  contentBase?: string | undefined;
  /**
   * How the account label is read once a token is in hand (`pick`
   * entries may be dotted paths). A `{token}` in the URL is the access
   * token itself (HubSpot describes a token at `/access-tokens/{token}`);
   * `fromTokenId` prefers the identity URL the token response itself
   * names (`id`, Salesforce) — the right host for a sandbox or a My
   * Domain — over `url`.
   */
  identity: { method: 'GET' | 'POST'; url: string; pick: string[]; fromTokenId?: boolean };
  /** Best-effort revocation on disconnect; absent = the user revokes at the provider. */
  revoke?: { url: string; style: 'token_param' | 'bearer' } | undefined;
  /**
   * The token response names the account's own API origin under this
   * key (Salesforce `instance_url`, Pipedrive `api_domain`); the grant
   * keeps it and connectors run against it.
   */
  apiBaseKey?: string | undefined;
  /**
   * The provider's login host is the operator's choice (Salesforce:
   * `login.salesforce.com`, `test.salesforce.com` for a sandbox, or a
   * My Domain) — SOURCE_OAUTH_<P>_LOGIN_URL swaps the origin of the
   * authorize / token / identity URLs, public hosts only (unlike the
   * dev override, no private opt-in is involved).
   */
  loginUrlEnv?: string | undefined;
}

const SPECS: Record<OAuthProviderId, OAuthProviderSpec> = {
  google: {
    id: 'google',
    title: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    baseScopes: ['openid', 'email'],
    apiBase: 'https://www.googleapis.com',
    identity: {
      method: 'GET',
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
      pick: ['email', 'sub'],
    },
    revoke: { url: 'https://oauth2.googleapis.com/revoke', style: 'token_param' },
  },
  microsoft: {
    id: 'microsoft',
    title: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authorizeParams: { response_mode: 'query', prompt: 'select_account' },
    baseScopes: ['offline_access', 'openid', 'User.Read'],
    apiBase: 'https://graph.microsoft.com/v1.0',
    identity: {
      method: 'GET',
      url: 'https://graph.microsoft.com/v1.0/me',
      pick: ['userPrincipalName', 'mail', 'id'],
    },
  },
  dropbox: {
    id: 'dropbox',
    title: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    authorizeParams: { token_access_type: 'offline' },
    baseScopes: ['account_info.read'],
    apiBase: 'https://api.dropboxapi.com',
    contentBase: 'https://content.dropboxapi.com',
    identity: {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/users/get_current_account',
      pick: ['email', 'account_id'],
    },
    revoke: { url: 'https://api.dropboxapi.com/2/auth/token/revoke', style: 'bearer' },
  },
  pipedrive: {
    id: 'pipedrive',
    title: 'Pipedrive',
    authorizeUrl: 'https://oauth.pipedrive.com/oauth/authorize',
    tokenUrl: 'https://oauth.pipedrive.com/oauth/token',
    // Pipedrive wants the app's credentials as HTTP Basic on the token
    // endpoint; its scopes are set on the app, not asked per grant.
    tokenAuth: 'basic',
    authorizeParams: {},
    baseScopes: [],
    apiBase: 'https://api.pipedrive.com',
    identity: {
      method: 'GET',
      url: 'https://api.pipedrive.com/v1/users/me',
      pick: ['data.email', 'data.name'],
    },
    apiBaseKey: 'api_domain',
  },
  hubspot: {
    id: 'hubspot',
    title: 'HubSpot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    // HubSpot always returns a refresh token; its scopes are asked per
    // grant (the connector names the objects it reads) and must be a
    // subset of the app's. No PKCE at HubSpot — the verifier we send is
    // ignored, the state + the app secret carry the flow.
    authorizeParams: {},
    baseScopes: ['oauth'],
    apiBase: 'https://api.hubapi.com',
    identity: {
      method: 'GET',
      url: 'https://api.hubapi.com/oauth/v1/access-tokens/{token}',
      pick: ['user', 'hub_domain'],
    },
  },
  salesforce: {
    id: 'salesforce',
    title: 'Salesforce',
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    // Web server flow with PKCE; `refresh_token` (= offline_access) is
    // asked as a base scope, `api` by the connector. The token response
    // names the org (`instance_url`) — every API call goes there, never
    // to the login host — and the identity URL (`id`) on the right host
    // for a production org, a sandbox or a My Domain.
    authorizeParams: {},
    baseScopes: ['openid', 'refresh_token'],
    apiBase: 'https://login.salesforce.com',
    identity: {
      method: 'GET',
      url: 'https://login.salesforce.com/services/oauth2/userinfo',
      // userinfo answers `preferred_username`; the token's own identity URL answers `username`.
      pick: ['preferred_username', 'username', 'email', 'user_id'],
      fromTokenId: true,
    },
    revoke: { url: 'https://login.salesforce.com/services/oauth2/revoke', style: 'token_param' },
    apiBaseKey: 'instance_url',
    loginUrlEnv: 'SOURCE_OAUTH_SALESFORCE_LOGIN_URL',
  },
};

/** A provider as this deployment can use it: its spec with the operator's app and any dev override applied. */
export interface ResolvedProvider extends OAuthProviderSpec {
  clientId: string;
  clientSecret: string;
  /** True when SOURCE_OAUTH_<P>_BASE_URL rerouted the provider (dev/test) — fetches then need the private opt-in. */
  private: boolean;
}

export function isOAuthProviderId(id: string): id is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(id);
}

export function providerSpec(id: OAuthProviderId): OAuthProviderSpec {
  return SPECS[id];
}

/** The operator's app and the dev override, per provider — literal names, so the catalogue gate sees their readers. */
const ENV_NAMES: Record<
  OAuthProviderId,
  { clientId: string; clientSecret: string; baseUrl: string }
> = {
  pipedrive: {
    clientId: 'SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_PIPEDRIVE_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_PIPEDRIVE_BASE_URL',
  },
  google: {
    clientId: 'SOURCE_OAUTH_GOOGLE_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_GOOGLE_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_GOOGLE_BASE_URL',
  },
  microsoft: {
    clientId: 'SOURCE_OAUTH_MICROSOFT_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_MICROSOFT_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_MICROSOFT_BASE_URL',
  },
  dropbox: {
    clientId: 'SOURCE_OAUTH_DROPBOX_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_DROPBOX_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_DROPBOX_BASE_URL',
  },
  hubspot: {
    clientId: 'SOURCE_OAUTH_HUBSPOT_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_HUBSPOT_BASE_URL',
  },
  salesforce: {
    clientId: 'SOURCE_OAUTH_SALESFORCE_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_SALESFORCE_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_SALESFORCE_BASE_URL',
  },
};

/** The env name of a provider's client id — what an operator must set. */
export function providerClientIdEnv(id: OAuthProviderId): string {
  return ENV_NAMES[id].clientId;
}

/** Whether the operator registered an app for this provider. */
export function providerConfigured(
  id: OAuthProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[ENV_NAMES[id].clientId]?.trim());
}

/**
 * The provider's URLs as this deployment reaches them: the spec, with
 * SOURCE_OAUTH_<P>_BASE_URL (dev/test) swapping every origin for one
 * fake server — paths kept. `private` says the override is in force,
 * so the fetches need the operator's private-egress opt-in.
 */
export function providerEndpoints(
  id: OAuthProviderId,
  env: NodeJS.ProcessEnv = process.env,
): OAuthProviderSpec & { private: boolean } {
  const spec = withLoginHost(SPECS[id], env);
  const override = env[ENV_NAMES[id].baseUrl]?.trim();
  if (!override) return { ...spec, private: false };
  const origin = override.replace(/\/$/, '');
  const re = (u: string) => `${origin}${new URL(u).pathname.replace(/\/$/, '')}`;
  return {
    ...spec,
    authorizeUrl: re(spec.authorizeUrl),
    tokenUrl: re(spec.tokenUrl),
    apiBase: re(spec.apiBase),
    contentBase: spec.contentBase ? re(spec.contentBase) : undefined,
    identity: { ...spec.identity, url: re(spec.identity.url) },
    revoke: spec.revoke ? { ...spec.revoke, url: re(spec.revoke.url) } : undefined,
    private: true,
  };
}

/** The operator's login host (public https only) on the authorize / token / identity / revoke URLs. */
function withLoginHost(spec: OAuthProviderSpec, env: NodeJS.ProcessEnv): OAuthProviderSpec {
  const raw = spec.loginUrlEnv ? env[spec.loginUrlEnv]?.trim() : undefined;
  if (!raw) return spec;
  let origin: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return spec;
    origin = u.origin;
  } catch {
    return spec;
  }
  const re = (u: string) => `${origin}${new URL(u).pathname}`;
  return {
    ...spec,
    authorizeUrl: re(spec.authorizeUrl),
    tokenUrl: re(spec.tokenUrl),
    identity: { ...spec.identity, url: re(spec.identity.url) },
    revoke: spec.revoke ? { ...spec.revoke, url: re(spec.revoke.url) } : undefined,
  };
}

/** The provider with the operator's app applied, or null when none is registered for it. */
export function resolveProvider(
  id: OAuthProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider | null {
  const clientId = env[ENV_NAMES[id].clientId]?.trim();
  if (!clientId) return null;
  const clientSecret = env[ENV_NAMES[id].clientSecret]?.trim() ?? '';
  return { ...providerEndpoints(id, env), clientId, clientSecret };
}

/**
 * The identity URL for one token: the `{token}` placeholder (also as the
 * URL parser percent-encodes it), when the provider has one, filled in;
 * the token response's own identity URL when the provider prefers it
 * (`fromTokenId`) and it is an https URL — rerouted to the dev
 * override's origin when one is in force (`private`), so a fake
 * provider on loopback still answers it.
 */
export function identityUrl(
  spec: OAuthProviderSpec & { private?: boolean },
  accessToken: string,
  tokenIdUrl?: string | undefined,
): string {
  if (spec.identity.fromTokenId && tokenIdUrl && /^https?:\/\//i.test(tokenIdUrl)) {
    if (spec.private) return `${new URL(spec.identity.url).origin}${new URL(tokenIdUrl).pathname}`;
    if (/^https:\/\//i.test(tokenIdUrl)) return tokenIdUrl;
  }
  return spec.identity.url.replace(/\{token\}|%7Btoken%7D/i, encodeURIComponent(accessToken));
}

/** The account label out of an identity response: the first named key that is a non-empty string. */
export function pickAccount(body: unknown, pick: string[]): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const k of pick) {
    let v: unknown = body;
    for (const part of k.split('.')) {
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    }
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
