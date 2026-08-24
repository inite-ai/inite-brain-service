/**
 * Server-side client to the brain backend.
 *
 * The BFFs (`/api/admin/proxy`, `/api/app/proxy`) call into here. The
 * user's cookie JWT is never forwarded verbatim — it has
 * audience='brain-landing' and the brain backend validates
 * audience='brain'.
 *
 * Preferred path: RFC 8693 token exchange. The BFF trades the user's
 * session token for an aud='brain' token that KEEPS the user identity —
 * `sub` (end-user), `org`/`org_id` (tenant) and an `act` claim naming
 * brain-landing as the acting party. Brain maps org→companyId and
 * sub→userId, which is what makes per-user memory scoping and
 * multi-tenant end-user deployments possible.
 *
 * Fallback path: `client_credentials` M2M mint (no user identity) —
 * used for calls with no user in scope and as a graceful degrade while
 * the auth-service hasn't granted the token-exchange grant yet.
 * Tokens of both kinds are cached in-process until ~30s before expiry.
 *
 * SECURITY: the M2M credential holds tenant-wide authority and the brain
 * backend lets it assert ANY userId (by design, for real M2M). So the
 * graceful-degrade fallback must NEVER kick in for an end-user request —
 * that would silently upgrade one user's session to cross-user authority.
 * Callers on the end-user path pass `requireUserIdentity: true`, which
 * makes a failed exchange throw {@link TokenExchangeError} (→ fail closed)
 * instead of degrading. The fallback survives only for genuinely
 * user-less / system / admin-operator calls.
 */

// Hard server-only gate. The OAUTH_CLIENT_SECRET this module mints
// tokens with must NEVER end up in the client bundle. server-only
// throws at module init when imported under client bundling, so any
// 'use client' file accidentally pulling brain-api in fails the
// Next.js build instead of silently leaking the secret.
import 'server-only'
import { createHash } from 'node:crypto'

const BRAIN_API_URL =
  process.env.BRAIN_API_URL ||
  process.env.NEXT_PUBLIC_BRAIN_API_URL ||
  'https://brain.inite.ai'

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const CLIENT_ID =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || ''

const BRAIN_AUDIENCE = process.env.BRAIN_AUDIENCE || 'brain'

/**
 * Full operator scope — used by the admin BFF (`/api/admin/proxy`).
 */
export const ADMIN_SCOPE =
  process.env.BRAIN_SCOPE || 'brain:read brain:write brain:admin brain:read_pii'

/**
 * Reduced scope for the end-user product BFF (`/api/app/proxy`).
 * Deliberately excludes `brain:admin` and `brain:read_pii` — PII
 * predicates come back as `__pii_redacted__` for ordinary users.
 */
export const USER_SCOPE = process.env.BRAIN_USER_SCOPE || 'brain:read brain:write'

interface CachedToken {
  accessToken: string
  /** Unix epoch ms; we refresh ~30s before this. */
  expiresAtMs: number
}

// One cache entry + one in-flight promise per requested scope set. A
// user request must never be served an admin-scoped token (or vice
// versa), so the scope string is the cache key.
const tokenCache = new Map<string, CachedToken>()
const inFlight = new Map<string, Promise<CachedToken>>()

async function fetchServiceToken(scope: string): Promise<CachedToken> {
  if (!CLIENT_SECRET) {
    throw new Error('OAUTH_CLIENT_SECRET is not configured')
  }
  const res = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope,
      audience: BRAIN_AUDIENCE,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `client_credentials grant failed: ${res.status} ${text.slice(0, 200)}`,
    )
  }
  const body = (await res.json()) as {
    access_token: string
    expires_in?: number
  }
  // M2M tokens default to 5min in auth-service. Refresh 30s early.
  const ttlSec = body.expires_in ?? 300
  return {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + (ttlSec - 30) * 1000,
  }
}

async function getServiceToken(scope: string): Promise<string> {
  const cached = tokenCache.get(scope)
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken
  }
  const pending = inFlight.get(scope)
  if (pending) {
    const t = await pending
    return t.accessToken
  }
  const p = fetchServiceToken(scope)
  inFlight.set(scope, p)
  try {
    const fresh = await p
    tokenCache.set(scope, fresh)
    return fresh.accessToken
  } finally {
    inFlight.delete(scope)
  }
}

// ── RFC 8693 token exchange (user identity preserved) ───────────────

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

// Exchanged tokens are per (user session × scope). Bounded so a busy
// multi-user deployment can't grow the map unboundedly — entries are
// tiny and expire in ~5min anyway.
const exchangeCache = new Map<string, CachedToken>()
const exchangeInFlight = new Map<string, Promise<CachedToken>>()
const MAX_EXCHANGE_ENTRIES = 500

function exchangeKey(subjectToken: string, scope: string): string {
  const digest = createHash('sha256').update(subjectToken).digest('hex').slice(0, 32)
  return `${digest}:${scope}`
}

async function fetchExchangedToken(
  subjectToken: string,
  scope: string,
): Promise<CachedToken> {
  if (!CLIENT_SECRET) {
    throw new Error('OAUTH_CLIENT_SECRET is not configured')
  }
  const res = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      subject_token: subjectToken,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      scope,
      audience: BRAIN_AUDIENCE,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `token exchange failed: ${res.status} ${text.slice(0, 200)}`,
    )
  }
  const body = (await res.json()) as {
    access_token: string
    expires_in?: number
  }
  const ttlSec = body.expires_in ?? 300
  return {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + (ttlSec - 30) * 1000,
  }
}

async function getExchangedToken(
  subjectToken: string,
  scope: string,
): Promise<string> {
  const key = exchangeKey(subjectToken, scope)
  const cached = exchangeCache.get(key)
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken
  }
  const pending = exchangeInFlight.get(key)
  if (pending) {
    const t = await pending
    return t.accessToken
  }
  const p = fetchExchangedToken(subjectToken, scope)
  exchangeInFlight.set(key, p)
  try {
    const fresh = await p
    if (exchangeCache.size >= MAX_EXCHANGE_ENTRIES) {
      const oldest = exchangeCache.keys().next().value
      if (oldest !== undefined) exchangeCache.delete(oldest)
    }
    exchangeCache.set(key, fresh)
    return fresh.accessToken
  } finally {
    exchangeInFlight.delete(key)
  }
}

/**
 * Thrown when an end-user request (`requireUserIdentity: true`) cannot
 * obtain an identity-preserving token. Callers translate it into a
 * fail-closed authorization error — the request is denied rather than
 * executed with the anonymous, tenant-wide M2M credential.
 */
export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenExchangeError'
  }
}

/**
 * Resolve the bearer token for a brain call. With a user session token,
 * prefer the identity-preserving exchange; degrade to the anonymous M2M
 * mint when exchange is unavailable (grant not provisioned yet, subject
 * token lacking brain scopes) so the dashboard keeps working during the
 * auth-service rollout.
 *
 * Fail-closed switch: when `requireUserIdentity` is set AND a `userToken`
 * is present, a failed exchange throws {@link TokenExchangeError} instead
 * of degrading to the tenant-wide M2M credential. The end-user BFF sets
 * this so a broken/unprovisioned exchange can never elevate a user
 * session to cross-user authority. It has no effect when no `userToken`
 * is supplied (genuinely user-less / dev-bypass / system calls still mint
 * M2M), and it is left off by the admin BFF, whose operator identity is
 * legitimately tenant-wide.
 */
export async function getBrainToken(opts: {
  scope: string
  userToken?: string | null
  requireUserIdentity?: boolean
}): Promise<string> {
  if (opts.userToken) {
    try {
      return await getExchangedToken(opts.userToken, opts.scope)
    } catch (err) {
      if (opts.requireUserIdentity) {
        // Fail closed: an authenticated end-user session must never be
        // downgraded to the anonymous, tenant-wide M2M credential.
        // Denying is safer than executing with cross-user authority.
        throw new TokenExchangeError(
          `token exchange failed for an end-user session; refusing to fall back to tenant-wide M2M authority: ${(err as Error).message}`,
        )
      }
      console.warn(
        `[brain-api] token exchange unavailable, falling back to client_credentials: ${(err as Error).message}`,
      )
    }
  }
  return getServiceToken(opts.scope)
}

export interface BrainFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
  /** Extra headers merged on top of Authorization/Content-Type. */
  headers?: Record<string, string>
  /**
   * OAuth scope set to mint the M2M token with. Defaults to
   * {@link ADMIN_SCOPE} for backward compatibility with the admin BFF.
   * The user BFF passes {@link USER_SCOPE}.
   */
  scope?: string
  /**
   * Static brain API key sent as the Bearer token INSTEAD of minting an
   * M2M JWT. Needed for the registry catalogue scopes
   * (`registry:publish` / `registry:curate`), which are deliberately
   * absent from the JWT `VALID_SCOPES` allowlist on the backend and can
   * only ride an env-provisioned `BRAIN_API_KEYS` key. Takes precedence
   * over {@link userToken}.
   */
  apiKey?: string
  /**
   * The caller's session access token (cookie JWT). When present, the
   * call rides an RFC 8693 exchange that preserves the user identity
   * downstream (per-user memory, audit attribution) instead of the
   * anonymous M2M mint.
   */
  userToken?: string | null
  /**
   * Fail-closed switch for the end-user path. When true and
   * {@link userToken} is present, a failed exchange makes this call
   * return an authorization error (403) rather than silently degrading
   * to the tenant-wide M2M credential. See {@link getBrainToken}.
   */
  requireUserIdentity?: boolean
}

export interface BrainResponse<T = unknown> {
  ok: boolean
  status: number
  data: T | null
  /**
   * Stable, client-safe error code (e.g. `identity_exchange_failed`).
   * Set on the error responses this module *synthesizes* (token minting /
   * transport failures). It deliberately carries NO backend or
   * auth-service internals — those are logged server-side only — so the
   * browser gets a fixed machine-readable code, never a leaked detail.
   */
  code?: string
  error?: string
}

function buildUrl(path: string, query?: BrainFetchOptions['query']): string {
  const url = new URL(path.replace(/^\/+/, '/'), BRAIN_API_URL)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

export async function brainFetch<T = unknown>(
  path: string,
  options: BrainFetchOptions = {},
): Promise<BrainResponse<T>> {
  const scope = options.scope ?? ADMIN_SCOPE
  let token: string
  if (options.apiKey) {
    token = options.apiKey
  } else {
    try {
      token = await getBrainToken({
        scope,
        userToken: options.userToken,
        requireUserIdentity: options.requireUserIdentity,
      })
    } catch (err) {
      // Never leak backend / auth-service internals to the browser. The
      // detail (which grant failed, the auth-service status, its response
      // body) is logged server-side; the client gets a STABLE code + a
      // generic message so it can branch on the failure class without
      // seeing token-endpoint diagnostics.
      if (err instanceof TokenExchangeError) {
        // Fail-closed exchange (end-user path, #342): surface a denial and
        // never issue the backend request with a fallback credential.
        console.error(
          `[brain-api] identity-preserving token exchange failed; failing closed (403): ${(err as Error).message}`,
        )
        return {
          ok: false,
          status: 403,
          data: null,
          code: 'identity_exchange_failed',
          error: 'Not authorized for this request.',
        }
      }
      console.error(
        `[brain-api] could not obtain a brain access token (500): ${(err as Error).message}`,
      )
      return {
        ok: false,
        status: 500,
        data: null,
        code: 'auth_unavailable',
        error: 'Authorization is temporarily unavailable.',
      }
    }
  }

  const url = buildUrl(path, options.query)
  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let data: T | null = null
    try {
      data = text ? (JSON.parse(text) as T) : null
    } catch {
      // raw text below
    }
    // On 401 the cached token may have been revoked — invalidate the
    // entries for this scope and let the next request re-mint. (Static
    // apiKey calls never touched the caches.)
    if (res.status === 401 && !options.apiKey) {
      tokenCache.delete(scope)
      if (options.userToken) {
        exchangeCache.delete(exchangeKey(options.userToken, scope))
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error:
          (data && (data as { error?: string }).error) ||
          text.slice(0, 300) ||
          res.statusText,
      }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: (err as Error).message,
    }
  }
}
