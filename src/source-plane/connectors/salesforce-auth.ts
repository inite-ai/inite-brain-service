import { createSign } from 'node:crypto';
import type { ConnectorCtx } from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import { safeFetch } from './safe-fetch';

/**
 * How a Salesforce connection authenticates (docs/roadmap/crm-sources-
 * 2026-09.md § 4.2.1, W4.2c) — two ways, one session:
 *
 *   connected account — the OAuth grant's access token (refreshed by
 *     the grant) against the org the grant learned at the token endpoint
 *     (`instance_url`); `config.instanceUrl` overrides it (a My Domain
 *     the admin prefers).
 *   JWT bearer — server-to-server for an integration user: the
 *     credential is a JSON `{ clientId, username, privateKey,
 *     loginUrl? }` (the connected app's consumer key, the user it runs
 *     as, the PEM private key whose certificate is on the app). The
 *     connector mints an RS256 assertion (3 minutes) per run, exchanges
 *     it at `<loginUrl>/services/oauth2/token`, and runs against the
 *     `instance_url` the answer names. No browser, no refresh token.
 *
 * The login host defaults to login.salesforce.com; a sandbox names
 * test.salesforce.com (`loginUrl` in the credential or `config.loginUrl`).
 * The dev override SOURCE_OAUTH_SALESFORCE_BASE_URL reroutes both the
 * login host and the org to one fake, under the private-egress opt-in.
 */

export interface SalesforceSession {
  token: string;
  /** The org's origin — every API call goes here. */
  instanceUrl: string;
  /** The dev override is in force: fetches need the private opt-in. */
  private: boolean;
}

export interface SalesforceConfig {
  entities?: string[] | undefined;
  mapping?: Record<string, unknown> | undefined;
  /** The org's My Domain origin (`https://acme.my.salesforce.com`); default = what the account or the JWT exchange named. */
  instanceUrl?: string | undefined;
  /** `https://login.salesforce.com` (default) or `https://test.salesforce.com` for a sandbox — JWT bearer only. */
  loginUrl?: string | undefined;
  /** REST API version (default v62.0). */
  apiVersion?: string | undefined;
  /** Bulk API 2.0 for the full walk (large orgs); incremental runs stay on the query endpoint. */
  bulk?: boolean | undefined;
  allowPrivate?: boolean | undefined;
}

interface JwtCredential {
  clientId: string;
  username: string;
  privateKey: string;
  loginUrl?: string | undefined;
}

const DEFAULT_LOGIN_URL = 'https://login.salesforce.com';
const JWT_TTL_S = 180;
const TOKEN_TIMEOUT_MS = 20_000;

/** The session for a run: a connected account's token + org, or a JWT bearer exchange. */
export async function salesforceSession(ctx: ConnectorCtx): Promise<SalesforceSession> {
  const cfg = ctx.connection.config as SalesforceConfig;
  const ep = providerEndpoints('salesforce');
  const credential = ctx.connection.credential;
  if (!credential) throw new Error('salesforce: no connected account or JWT bearer credential');
  if (ctx.connection.credentialSource === 'grant') {
    const instanceUrl = ep.private
      ? ep.apiBase
      : originOf(cfg.instanceUrl) || ctx.connection.grant?.apiBase || '';
    if (!instanceUrl) {
      throw new Error(
        'salesforce: the connected account named no org (instance_url) — reconnect it or set config.instanceUrl',
      );
    }
    return { token: credential, instanceUrl, private: ep.private };
  }
  const jwt = parseJwtCredential(credential);
  const loginUrl = ep.private
    ? ep.apiBase
    : originOf(jwt.loginUrl) || originOf(cfg.loginUrl) || DEFAULT_LOGIN_URL;
  const allowPrivate = ep.private || cfg.allowPrivate === true;
  const assertion = mintAssertion(jwt, loginUrl);
  const res = await safeFetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    allowPrivate,
    signal: ctx.signal,
    timeoutMs: TOKEN_TIMEOUT_MS,
    maxBytes: 64 * 1024,
  });
  let json: {
    access_token?: unknown;
    instance_url?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error(`salesforce: the token endpoint answered ${res.status} with a non-JSON body`);
  }
  if (res.status !== 200 || typeof json.access_token !== 'string') {
    const err = typeof json.error === 'string' ? json.error : `http ${res.status}`;
    const desc = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
    throw new Error(`salesforce: JWT bearer refused (${err}${desc})`);
  }
  const instanceUrl = ep.private
    ? ep.apiBase
    : originOf(cfg.instanceUrl) ||
      (typeof json.instance_url === 'string' ? originOf(json.instance_url) : '');
  if (!instanceUrl) throw new Error('salesforce: the token answer named no instance_url');
  return { token: json.access_token, instanceUrl, private: allowPrivate };
}

/** `{ clientId, username, privateKey, loginUrl? }` — every part named in the error, the key never. */
export function parseJwtCredential(credential: string): JwtCredential {
  let parsed: Partial<JwtCredential>;
  try {
    parsed = JSON.parse(credential) as Partial<JwtCredential>;
  } catch {
    throw new Error(
      'salesforce: the credential is neither a connected account nor a JWT bearer JSON { clientId, username, privateKey }',
    );
  }
  for (const k of ['clientId', 'username', 'privateKey'] as const) {
    if (typeof parsed[k] !== 'string' || parsed[k].trim().length === 0) {
      throw new Error(`salesforce: the JWT bearer credential lacks "${k}"`);
    }
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(parsed.privateKey!)) {
    throw new Error('salesforce: privateKey must be a PEM private key');
  }
  return {
    clientId: parsed.clientId!.trim(),
    username: parsed.username!.trim(),
    privateKey: parsed.privateKey!,
    ...(typeof parsed.loginUrl === 'string' ? { loginUrl: parsed.loginUrl } : {}),
  };
}

/** RS256 over `base64url(header).base64url(claims)`; `aud` is the login host, `exp` three minutes out. */
export function mintAssertion(jwt: JwtCredential, loginUrl: string, now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: jwt.clientId,
      sub: jwt.username,
      aud: loginUrl,
      exp: Math.floor(now / 1000) + JWT_TTL_S,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(jwt.privateKey)
    .toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/** An https origin out of a URL-ish string (the dev override admits http), else ''. */
export function originOf(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '';
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
