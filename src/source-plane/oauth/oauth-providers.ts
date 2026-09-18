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

export type OAuthProviderId = 'google' | 'microsoft' | 'dropbox';

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = ['google', 'microsoft', 'dropbox'];

export interface OAuthProviderSpec {
  id: OAuthProviderId;
  title: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Provider-specific authorize parameters (offline access, consent). */
  authorizeParams: Record<string, string>;
  /** Scopes every grant of this provider carries (identity), beyond what a connector asks. */
  baseScopes: string[];
  /** The API origin the connectors talk to. */
  apiBase: string;
  /** A second origin for bytes (Dropbox serves content from its own host). */
  contentBase?: string | undefined;
  /** How the account label is read once a token is in hand. */
  identity: { method: 'GET' | 'POST'; url: string; pick: string[] };
  /** Best-effort revocation on disconnect; absent = the user revokes at the provider. */
  revoke?: { url: string; style: 'token_param' | 'bearer' } | undefined;
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
  const spec = SPECS[id];
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

/** The account label out of an identity response: the first named key that is a non-empty string. */
export function pickAccount(body: unknown, pick: string[]): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  for (const k of pick) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
