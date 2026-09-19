import { safeFetch, type SafeFetchResult } from '../connectors/safe-fetch';

/**
 * How the brain learns to sign in at an MCP server it has never seen
 * (docs/roadmap/crm-sources-2026-09.md § 4.5, W4.3) — the 2025-06-18+
 * MCP authorization flow, pure functions over the egress guard:
 *
 *   1. an unauthenticated request to the server answers 401 with
 *      `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728) — or
 *      the metadata sits at `/.well-known/oauth-protected-resource[<path>]`;
 *   2. the protected-resource metadata names its authorization servers
 *      (and the scopes the resource takes); without any, the server's
 *      own origin is tried as the authorization server;
 *   3. the authorization server's metadata (RFC 8414, path-aware; then
 *      OpenID discovery) names the authorize / token / registration /
 *      revocation endpoints;
 *   4. a client is registered dynamically (RFC 7591) when the server
 *      offers it — a public client with PKCE by default, a secret only
 *      when the server issues one.
 *
 * Every hop is `safeFetch` (the SSRF fence; loopback / LAN only under
 * the double opt-in), bounded in bytes and time, redirects never
 * followed on the probe. Nothing here stores anything.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  codeChallengeMethods: string[];
  tokenEndpointAuthMethods: string[];
  scopesSupported: string[];
}

export interface DiscoveredAuth {
  /** The MCP server URL as named (the RFC 8707 `resource` the tokens are bound to). */
  resource: string;
  prm: ProtectedResourceMetadata | null;
  as: AuthorizationServerMetadata;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  tokenAuth: 'none' | 'body' | 'basic';
}

const FETCH_MS = 15_000;
const MAX_BYTES = 256 * 1024;
const PRM_WELL_KNOWN = '/.well-known/oauth-protected-resource';
const AS_WELL_KNOWN = '/.well-known/oauth-authorization-server';
const OIDC_WELL_KNOWN = '/.well-known/openid-configuration';

export interface DiscoveryOptions {
  allowPrivate: boolean;
  signal?: AbortSignal | undefined;
}

export class McpOAuthDiscoveryError extends Error {}

export async function discoverMcpAuth(
  serverUrl: string,
  opts: DiscoveryOptions,
): Promise<DiscoveredAuth> {
  const resource = canonicalResource(serverUrl);
  const prm = await protectedResourceMetadata(resource, opts);
  const issuers = prm?.authorizationServers.length
    ? prm.authorizationServers
    : [new URL(resource).origin];
  let lastError: string | null = null;
  for (const issuer of issuers) {
    try {
      const as = await authorizationServerMetadata(issuer, opts);
      return { resource, prm, as };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new McpOAuthDiscoveryError(
    `no authorization server metadata for ${resource}${lastError ? ` (${lastError})` : ''}`,
  );
}

/** The URL as the RFC 8707 resource: origin + path, no fragment, no trailing slash beyond the root. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}${u.search}`;
}

/** `Bearer realm="…", resource_metadata="…"` → the metadata URL, or null. */
export function resourceMetadataUrlOf(wwwAuthenticate: string | null | undefined): string | null {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
  return m?.[1] ?? null;
}

/**
 * RFC 9728: the metadata the 401 names, else the well-known path (path-
 * aware first, then the origin's). Null when the server publishes none
 * — an authorization server may still sit at its origin.
 */
async function protectedResourceMetadata(
  resource: string,
  opts: DiscoveryOptions,
): Promise<ProtectedResourceMetadata | null> {
  const probe = await probeServer(resource, opts);
  const candidates: string[] = [];
  const named = resourceMetadataUrlOf(probe?.headers.get('www-authenticate'));
  if (named) candidates.push(new URL(named, resource).toString());
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, '');
  if (path) candidates.push(`${u.origin}${PRM_WELL_KNOWN}${path}`);
  candidates.push(`${u.origin}${PRM_WELL_KNOWN}`);
  for (const url of [...new Set(candidates)]) {
    const json = await getJson(url, opts);
    if (!json) continue;
    const servers = json.authorization_servers;
    const out: ProtectedResourceMetadata = {
      resource: typeof json.resource === 'string' ? json.resource : resource,
      authorizationServers: Array.isArray(servers)
        ? servers.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [],
      scopesSupported: stringList(json.scopes_supported),
    };
    // The metadata must be about this server — a document for another resource is not ours.
    if (!sameResource(out.resource, resource)) continue;
    return out;
  }
  return null;
}

/** RFC 8414 (path-aware), then OpenID discovery — the first document with the two endpoints wins. */
export async function authorizationServerMetadata(
  issuer: string,
  opts: DiscoveryOptions,
): Promise<AuthorizationServerMetadata> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  const candidates = [
    `${u.origin}${AS_WELL_KNOWN}${path}`,
    ...(path ? [`${u.origin}${AS_WELL_KNOWN}`] : []),
    `${u.origin}${OIDC_WELL_KNOWN}${path}`,
    `${u.origin}${path}${OIDC_WELL_KNOWN}`,
  ];
  for (const url of [...new Set(candidates)]) {
    const json = await getJson(url, opts);
    if (!json) continue;
    const authorizationEndpoint = json.authorization_endpoint;
    const tokenEndpoint = json.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') continue;
    return {
      issuer: typeof json.issuer === 'string' ? json.issuer : issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        typeof json.registration_endpoint === 'string' ? json.registration_endpoint : null,
      revocationEndpoint:
        typeof json.revocation_endpoint === 'string' ? json.revocation_endpoint : null,
      codeChallengeMethods: stringList(json.code_challenge_methods_supported),
      tokenEndpointAuthMethods: stringList(json.token_endpoint_auth_methods_supported),
      scopesSupported: stringList(json.scopes_supported),
    };
  }
  throw new McpOAuthDiscoveryError(`${issuer} publishes no authorization server metadata`);
}

/**
 * RFC 7591: register the brain as a client — public (`none`, PKCE
 * carries the flow) unless the server only takes clients with a secret,
 * in which case `client_secret_post`; the answer's own method and
 * secret win.
 */
export async function registerClient(
  as: AuthorizationServerMetadata,
  p: { redirectUri: string; clientName: string; scopes: string[] },
  opts: DiscoveryOptions,
): Promise<RegisteredClient> {
  if (!as.registrationEndpoint) {
    throw new McpOAuthDiscoveryError(
      `${as.issuer} offers no dynamic client registration — register a client there and pass its id (and secret)`,
    );
  }
  const methods = as.tokenEndpointAuthMethods;
  const wanted =
    methods.length === 0 || methods.includes('none')
      ? 'none'
      : methods.includes('client_secret_post')
        ? 'client_secret_post'
        : 'client_secret_basic';
  const res = await safeFetch(as.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: p.clientName,
      redirect_uris: [p.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: wanted,
      ...(p.scopes.length > 0 ? { scope: p.scopes.join(' ') } : {}),
    }),
    allowPrivate: opts.allowPrivate,
    signal: opts.signal,
    timeoutMs: FETCH_MS,
    maxBytes: MAX_BYTES,
  });
  const json = parseJson(res);
  if (res.status < 200 || res.status >= 300 || typeof json?.client_id !== 'string') {
    const err = typeof json?.error === 'string' ? json.error : `http ${res.status}`;
    const desc = typeof json?.error_description === 'string' ? `: ${json.error_description}` : '';
    throw new McpOAuthDiscoveryError(`client registration at ${as.issuer} refused (${err}${desc})`);
  }
  const method =
    typeof json.token_endpoint_auth_method === 'string' ? json.token_endpoint_auth_method : wanted;
  const secret = typeof json.client_secret === 'string' ? json.client_secret : null;
  return {
    clientId: json.client_id,
    clientSecret: secret,
    tokenAuth:
      !secret || method === 'none' ? 'none' : method === 'client_secret_basic' ? 'basic' : 'body',
  };
}

/** An unauthenticated JSON-RPC `initialize` — what a client sends first; a 401 with its challenge is the answer we want. */
async function probeServer(
  resource: string,
  opts: DiscoveryOptions,
): Promise<SafeFetchResult | null> {
  try {
    return await safeFetch(resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'inite-brain', version: '1.0' },
        },
      }),
      allowPrivate: opts.allowPrivate,
      signal: opts.signal,
      timeoutMs: FETCH_MS,
      maxBytes: MAX_BYTES,
      maxRedirects: 0,
    });
  } catch {
    return null;
  }
}

async function getJson(
  url: string,
  opts: DiscoveryOptions,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      allowPrivate: opts.allowPrivate,
      signal: opts.signal,
      timeoutMs: FETCH_MS,
      maxBytes: MAX_BYTES,
    });
    if (res.status !== 200) return null;
    return parseJson(res);
  } catch {
    return null;
  }
}

function parseJson(res: SafeFetchResult): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(res.body.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** The metadata's `resource` names this server: equal, or a prefix of it (a server under a path of the resource). */
function sameResource(declared: string, wanted: string): boolean {
  try {
    const a = canonicalResource(declared);
    const b = canonicalResource(wanted);
    return (
      a === b ||
      b.startsWith(`${a}/`) ||
      (new URL(a).pathname === '/' && new URL(a).origin === new URL(b).origin)
    );
  } catch {
    return false;
  }
}
