/**
 * Which `iss` and `aud` values brain accepts on a token from the INITE
 * auth-service — one answer for both remote verifiers (the JWKS path and
 * RFC 7662 introspection), so the two can never disagree about what a
 * correctly-issued token looks like.
 *
 * The rules are the INITE Triad token contract
 * (inite-ecosystem/docs/triad-compatibility.md):
 *  - `iss` is compared exactly, but the configured value may be a list
 *    (an issuer migration accepts old and new for one minor) and a
 *    trailing slash on either side is not a different issuer.
 *  - `aud` is one of: the vertical name (`brain`, what an operator-issued
 *    key or an `audience=brain` M2M grant carries), this deployment's
 *    public URL, `<url>/mcp`, or `<url>/mcp/<companyId>` — the resource
 *    the per-tenant RFC 9728 document advertises — but only for the
 *    tenant the token itself names.
 */

type ConfigGet = (key: string) => string | undefined;

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Accepted issuers from AUTH_SERVICE_ISSUER (comma-separated). Each entry
 * is accepted with and without a trailing slash: the auth-service signs
 * its configured JWT_ISSUER verbatim, and an operator copying the value
 * from a URL bar should not lock every user out over one character.
 */
export function acceptedIssuers(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const entry of list(raw)) {
    const bare = withoutTrailingSlash(entry);
    if (!bare) continue;
    out.add(bare);
    out.add(`${bare}/`);
  }
  return [...out];
}

/**
 * The static `aud` allow-list: AUTH_SERVICE_AUDIENCES when set (replaces
 * the derived list outright), otherwise the vertical name
 * (AUTH_SERVICE_AUDIENCE, default `brain`) plus BRAIN_PUBLIC_URL and
 * `<BRAIN_PUBLIC_URL>/mcp`.
 */
export function acceptedAudiences(get: ConfigGet): string[] {
  const explicit = list(get('AUTH_SERVICE_AUDIENCES'));
  if (explicit.length > 0) return explicit;
  const vertical = get('AUTH_SERVICE_AUDIENCE') ?? 'brain';
  const raw = get('BRAIN_PUBLIC_URL');
  const base = raw ? withoutTrailingSlash(raw) : undefined;
  return [...new Set([vertical, ...(base ? [base, `${base}/mcp`] : [])])].filter(Boolean);
}

/**
 * Does the token's `aud` (string or array, per RFC 7519 §4.1.3) name this
 * deployment? `companyId` is the tenant the token resolved to: a
 * per-tenant resource only counts for its own tenant, so a token bound to
 * `/mcp/co_a` can never be spent on `co_b`.
 */
export function audienceAccepted(
  aud: unknown,
  here: { accepted: readonly string[]; publicUrl: string | undefined; companyId: string },
): boolean {
  const values = (Array.isArray(aud) ? aud : [aud]).filter(
    (a): a is string => typeof a === 'string' && a.length > 0,
  );
  if (values.length === 0) return false;
  const tenantResource = here.publicUrl
    ? `${withoutTrailingSlash(here.publicUrl)}/mcp/${here.companyId}`
    : undefined;
  return values.some(
    (a) => here.accepted.includes(a) || (tenantResource !== undefined && a === tenantResource),
  );
}
