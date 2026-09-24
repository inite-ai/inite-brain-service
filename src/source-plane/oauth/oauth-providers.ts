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
  | 'google'
  | 'microsoft'
  | 'dropbox'
  | 'pipedrive'
  | 'hubspot'
  | 'salesforce'
  | 'bitrix24'
  | 'kommo'
  | 'notion'
  | 'atlassian'
  | 'slack';

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = [
  'google',
  'microsoft',
  'dropbox',
  'pipedrive',
  'hubspot',
  'salesforce',
  'bitrix24',
  'kommo',
  'notion',
  'atlassian',
  'slack',
];

/**
 * The account's host in a URL — `https://{host}/oauth2/access_token` —
 * for a vendor whose endpoints live on the account's own domain (Kommo:
 * the token endpoint and the API; Bitrix24: the portal's REST). Filled
 * from the callback (`accountHost`) or from the grant's `apiBase`.
 */
export const HOST_PLACEHOLDER = '{host}';
/** A syntactically valid stand-in so a template still parses as a URL. */
const HOST_STANDIN = 'account.invalid';

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
  identity: {
    method: 'GET' | 'POST';
    url: string;
    pick: string[];
    fromTokenId?: boolean;
    /** Headers the identity call needs beyond the bearer (Notion's API version). */
    headers?: Record<string, string> | undefined;
  };
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
   * My Domain; Kommo: `www.amocrm.ru` for amoCRM; Bitrix24: the portal
   * itself, to skip the portal prompt) — SOURCE_OAUTH_<P>_LOGIN_URL
   * swaps the origin of the authorize / token / identity URLs, public
   * hosts only (unlike the dev override, no private opt-in is
   * involved). A URL on the account's host (`{host}`) is left alone.
   */
  loginUrlEnv?: string | undefined;
  /**
   * How the token endpoint takes its parameters: a form body (the
   * standard, default), a JSON body (Kommo), or the query string of a
   * GET (Bitrix24).
   */
  tokenRequest?: 'form' | 'json' | 'query' | undefined;
  /**
   * The callback names the account's host under this query parameter
   * (Kommo `referer` = `<subdomain>.kommo.com`) and the token endpoint
   * lives there; the host must end in one of the suffixes — the app's
   * secret goes to that host, so a callback naming any other is refused.
   */
  accountHost?: { param: string; suffixes: string[] } | undefined;
  /** The refresh request carries `redirect_uri` too (Kommo asks for it). */
  refreshWithRedirectUri?: boolean | undefined;
  /**
   * False = the provider's token endpoint validates its body strictly
   * and knows no PKCE (Notion, Atlassian's 3LO): no challenge is sent,
   * no verifier is exchanged — the signed state and the app's secret
   * carry the flow.
   */
  pkce?: boolean | undefined;
}

/** The Notion API version every call names (the connector and the identity lookup). */
export const NOTION_VERSION = '2022-06-28';

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
  bitrix24: {
    id: 'bitrix24',
    title: 'Bitrix24',
    // The "full" authorization: oauth.bitrix.info asks which portal, the
    // portal consents, the token endpoint is a GET with the parameters
    // in the query and answers the portal's REST root (`client_endpoint`
    // → the grant's apiBase). Scopes are fixed on the app (a local
    // application or a Marketplace one); no PKCE at Bitrix24 — the
    // verifier is ignored, the state + the app secret carry the flow.
    // The refresh token lives 28 days: a connection that syncs at least
    // monthly never needs reconnecting. SOURCE_OAUTH_BITRIX24_LOGIN_URL
    // = the portal's own origin skips the portal prompt (its
    // /oauth/authorize/ and /oauth/token/ speak the same protocol).
    authorizeUrl: 'https://oauth.bitrix.info/oauth/authorize/',
    tokenUrl: 'https://oauth.bitrix.info/oauth/token/',
    tokenRequest: 'query',
    authorizeParams: {},
    baseScopes: [],
    apiBase: 'https://oauth.bitrix.info',
    identity: {
      method: 'GET',
      url: `https://${HOST_PLACEHOLDER}/rest/profile.json`,
      pick: ['result.EMAIL', 'result.NAME', 'result.ID'],
    },
    apiBaseKey: 'client_endpoint',
    loginUrlEnv: 'SOURCE_OAUTH_BITRIX24_LOGIN_URL',
  },
  kommo: {
    id: 'kommo',
    title: 'Kommo / amoCRM',
    // The consent page is www.kommo.com (www.amocrm.ru for amoCRM —
    // SOURCE_OAUTH_KOMMO_LOGIN_URL); the callback carries `referer`, the
    // account's own host, where the token endpoint lives and takes JSON.
    // Refresh tokens rotate on every use (24 h access, 3 months
    // refresh) and the refresh asks for redirect_uri too. Scopes are
    // the integration's; no PKCE.
    authorizeUrl: 'https://www.kommo.com/oauth',
    tokenUrl: `https://${HOST_PLACEHOLDER}/oauth2/access_token`,
    tokenRequest: 'json',
    authorizeParams: { mode: 'popup' },
    baseScopes: [],
    apiBase: 'https://www.kommo.com',
    identity: {
      method: 'GET',
      url: `https://${HOST_PLACEHOLDER}/api/v4/account`,
      pick: ['name', 'subdomain'],
    },
    accountHost: { param: 'referer', suffixes: ['.kommo.com', '.amocrm.ru', '.amocrm.com'] },
    refreshWithRedirectUri: true,
    loginUrlEnv: 'SOURCE_OAUTH_KOMMO_LOGIN_URL',
  },
  notion: {
    id: 'notion',
    title: 'Notion',
    // A public integration: the token endpoint wants the app's
    // credentials as HTTP Basic and a JSON body it validates strictly
    // (no PKCE); the token never expires and no refresh token is
    // issued — a revoked integration is a 401 the connector names.
    // Capabilities (read content, read user information) are set on the
    // integration, not asked per grant; `owner=user` asks the person
    // to pick the pages the integration may see.
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    tokenAuth: 'basic',
    tokenRequest: 'json',
    pkce: false,
    authorizeParams: { owner: 'user' },
    baseScopes: [],
    apiBase: 'https://api.notion.com',
    identity: {
      method: 'GET',
      url: 'https://api.notion.com/v1/users/me',
      pick: ['bot.workspace_name', 'name', 'id'],
      headers: { 'notion-version': NOTION_VERSION },
    },
  },
  atlassian: {
    id: 'atlassian',
    title: 'Atlassian (Confluence)',
    // 3LO: consent at auth.atlassian.com for the api.atlassian.com
    // audience, a JSON token endpoint with the app's credentials in the
    // body, `offline_access` for a (rotating) refresh token — one hour
    // of access at a time. No PKCE. The site (cloud id) is found through
    // accessible-resources by the connector.
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    tokenRequest: 'json',
    pkce: false,
    authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    baseScopes: ['offline_access'],
    apiBase: 'https://api.atlassian.com',
    identity: {
      method: 'GET',
      url: 'https://api.atlassian.com/me',
      pick: ['email', 'name', 'account_id'],
    },
  },
  slack: {
    id: 'slack',
    title: 'Slack',
    // OAuth v2: the bot scopes ride as `scope`, the token endpoint takes
    // a form body with the app's credentials, the answer is the BOT
    // token (`token_type: bot`) for the workspace — no expiry unless the
    // app opted into token rotation (not supported here), so no refresh.
    // Slack answers HTTP 200 with `ok: false` on failure (exchange
    // checks). No PKCE. The workspace (`auth.test` → team) is the account.
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    pkce: false,
    authorizeParams: {},
    baseScopes: [],
    apiBase: 'https://slack.com/api',
    identity: {
      method: 'GET',
      url: 'https://slack.com/api/auth.test',
      pick: ['team', 'user', 'team_id'],
    },
    revoke: { url: 'https://slack.com/api/auth.revoke', style: 'bearer' },
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
  bitrix24: {
    clientId: 'SOURCE_OAUTH_BITRIX24_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_BITRIX24_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_BITRIX24_BASE_URL',
  },
  kommo: {
    clientId: 'SOURCE_OAUTH_KOMMO_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_KOMMO_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_KOMMO_BASE_URL',
  },
  notion: {
    clientId: 'SOURCE_OAUTH_NOTION_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_NOTION_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_NOTION_BASE_URL',
  },
  atlassian: {
    clientId: 'SOURCE_OAUTH_ATLASSIAN_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_ATLASSIAN_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_ATLASSIAN_BASE_URL',
  },
  slack: {
    clientId: 'SOURCE_OAUTH_SLACK_CLIENT_ID',
    clientSecret: 'SOURCE_OAUTH_SLACK_CLIENT_SECRET',
    baseUrl: 'SOURCE_OAUTH_SLACK_BASE_URL',
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
  const re = (u: string) => `${origin}${pathOf(u).replace(/\/$/, '')}`;
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

/** The path of a URL that may carry the `{host}` placeholder. */
function pathOf(u: string): string {
  return new URL(u.replace(HOST_PLACEHOLDER, HOST_STANDIN)).pathname;
}

/** The URL with the account's host in place of the placeholder (a URL without one is returned as is). */
export function fillHost(u: string, host: string | null | undefined): string {
  if (!u.includes(HOST_PLACEHOLDER)) return u;
  if (!host) throw new Error('the account host is not known');
  return u.replace(HOST_PLACEHOLDER, host);
}

export function hasHostPlaceholder(u: string): boolean {
  return u.includes(HOST_PLACEHOLDER);
}

/**
 * The account's host a callback names (`spec.accountHost.param`),
 * accepted only as a bare hostname (optionally with a port) under one
 * of the vendor's suffixes — the app's secret is sent to it. Under the
 * dev override (`private`) the token URL is rerouted anyway, so any
 * hostname passes. Null when the spec names no such parameter.
 */
export function accountHostOf(
  spec: OAuthProviderSpec & { private?: boolean },
  params: Record<string, string | undefined>,
): string | null {
  if (!spec.accountHost) return null;
  const raw = params[spec.accountHost.param]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(raw)) {
    throw new Error(
      `the callback names no account host (${spec.accountHost.param}) — start the sign-in again`,
    );
  }
  const bare = raw.replace(/:\d+$/, '');
  if (!spec.private && !spec.accountHost.suffixes.some((sfx) => bare.endsWith(sfx))) {
    throw new Error(`the callback names an account host outside ${spec.title} (${bare})`);
  }
  return raw;
}

/** The operator's login host (public https only) on the authorize / token / identity / revoke URLs; a URL on the account's host is left alone. */
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
  const re = (u: string) => (hasHostPlaceholder(u) ? u : `${origin}${pathOf(u)}`);
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
  from: { tokenIdUrl?: string | undefined; accountHost?: string | null | undefined } = {},
): string {
  const { tokenIdUrl, accountHost } = from;
  if (spec.identity.fromTokenId && tokenIdUrl && /^https?:\/\//i.test(tokenIdUrl)) {
    if (spec.private) return `${new URL(spec.identity.url).origin}${new URL(tokenIdUrl).pathname}`;
    if (/^https:\/\//i.test(tokenIdUrl)) return tokenIdUrl;
  }
  return fillHost(spec.identity.url, accountHost).replace(
    /\{token\}|%7Btoken%7D/i,
    encodeURIComponent(accessToken),
  );
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
