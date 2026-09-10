/**
 * RFC 9728 (OAuth 2.0 Protected Resource Metadata) URL helpers.
 *
 * Brain advertises itself as an OAuth protected resource so MCP clients
 * can discover the authorization server without out-of-band setup: a 401
 * carries `WWW-Authenticate: Bearer resource_metadata="…"`, the client
 * fetches that document, finds auth.inite.ai, self-registers (RFC 7591)
 * and runs the device/PKCE flow. Pure module — used by the guard and the
 * well-known controller alike.
 */

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  protocol?: string;
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Proxies may fold multiple hops into a comma-separated list — the
  // first entry is the client-facing edge.
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Public base URL of this deployment as seen by the caller, honouring
 * reverse-proxy forwarding headers. BRAIN_PUBLIC_URL (when set) wins so
 * a multi-hostname deploy advertises one canonical resource identifier.
 * Returns null when the host cannot be determined (bare socket probes).
 */
export function requestBaseUrl(req: RequestLike): string | null {
  const configured = process.env.BRAIN_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = headerValue(req.headers, 'x-forwarded-host') ?? headerValue(req.headers, 'host');
  if (!host) return null;
  const proto = headerValue(req.headers, 'x-forwarded-proto') ?? req.protocol ?? 'https';
  return `${proto}://${host}`;
}

/** Absolute URL of the RFC 9728 metadata document, or null without a host. */
export function resourceMetadataUrl(req: RequestLike): string | null {
  const base = requestBaseUrl(req);
  return base ? `${base}${PROTECTED_RESOURCE_PATH}` : null;
}

/**
 * A resource identified by a path (our per-tenant `/mcp/<companyId>`)
 * gets its metadata at `/.well-known/oauth-protected-resource/<path>`
 * per RFC 9728 §3.1 — clients that build the URL themselves, instead of
 * following the one named in `WWW-Authenticate`, look there first.
 *
 * Returns the suffix with its leading slash, or '' when there is none.
 * The suffix is echoed back inside the `resource` identifier, so
 * anything that isn't a plain path is dropped rather than reflected.
 */
export function resourcePathSuffix(req: { path?: string; url?: string }): string {
  const raw = (req.path ?? req.url ?? '').split('?')[0] ?? '';
  const start = raw.indexOf(PROTECTED_RESOURCE_PATH);
  if (start < 0) return '';
  const suffix = raw.slice(start + PROTECTED_RESOURCE_PATH.length).replace(/\/+$/, '');
  return /^\/[A-Za-z0-9._~\-/]{1,128}$/.test(suffix) ? suffix : '';
}
