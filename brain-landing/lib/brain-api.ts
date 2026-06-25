/**
 * Server-side client to the brain backend.
 *
 * The admin BFF (`/api/admin/proxy/[...path]`) calls into here. We
 * intentionally do NOT forward the user's cookie JWT — that token has
 * audience='brain-landing' and brain backend validates audience='brain'.
 *
 * Instead, brain-landing acts as an OAuth client and mints a
 * machine-to-machine token via the `client_credentials` grant against
 * auth.inite.ai. The token has aud='brain' and scopes=brain:admin
 * (subject to client allowlist on the auth-service side). Tokens are
 * cached in-process until ~30s before expiry.
 */

// Hard server-only gate. The OAUTH_CLIENT_SECRET this module mints
// tokens with must NEVER end up in the client bundle. server-only
// throws at module init when imported under client bundling, so any
// 'use client' file accidentally pulling brain-api in fails the
// Next.js build instead of silently leaking the secret.
import 'server-only'

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
}

export interface BrainResponse<T = unknown> {
  ok: boolean
  status: number
  data: T | null
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
  try {
    token = await getServiceToken(scope)
  } catch (err) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: (err as Error).message,
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
    // entry for this scope and let the next request re-mint.
    if (res.status === 401) {
      tokenCache.delete(scope)
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
