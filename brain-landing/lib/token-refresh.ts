import type { NextRequest, NextResponse } from 'next/server'

/**
 * Silent session renewal against auth.inite.ai.
 *
 * The OAuth callback stores two cookies: `access_token` for as long as
 * the identity provider says it lives (`expires_in`, five minutes on
 * prod) and `refresh_token` for seven days. Nothing ever used the second
 * one: when the first expired, the edge guard bounced the browser to
 * `/api/auth/login` and the BFF answered 401, so every Playground and
 * admin session ended after five minutes in a full consent screen
 * (found dogfooding the deploy checks, 2026-09-18). The refresh grant
 * exists for exactly this; both guards call it and re-set the cookies.
 *
 * Shared by the edge middleware and the Node route handlers, so it
 * imports nothing runtime-specific and never touches `server-only`.
 */

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const CLIENT_ID =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

/** Default access-token lifetime when the provider omits `expires_in`. */
const DEFAULT_ACCESS_TTL_SEC = 60 * 60 * 8
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60

export interface RefreshedTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

/**
 * Exchange a refresh token for a new access token (RFC 6749 §6). Null on
 * any failure — no secret configured, provider says no, network error —
 * so a caller degrades to exactly the unauthenticated path it had.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<RefreshedTokens | null> {
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || ''
  if (!clientSecret) return null
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: clientSecret,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<RefreshedTokens>
    if (typeof body.access_token !== 'string' || !body.access_token) return null
    return {
      access_token: body.access_token,
      ...(typeof body.refresh_token === 'string' && body.refresh_token
        ? { refresh_token: body.refresh_token }
        : {}),
      ...(typeof body.expires_in === 'number' ? { expires_in: body.expires_in } : {}),
    }
  } catch {
    return null
  }
}

/** The cookie attributes the OAuth callback writes — one copy. */
function cookieAttrs(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  }
}

/**
 * Write renewed tokens onto a response the way the callback does: the
 * access token for its lifetime, the (rotated) refresh token for a week.
 * A provider that does not rotate leaves the old refresh cookie standing.
 */
export function setSessionCookies(res: NextResponse, tokens: RefreshedTokens): void {
  res.cookies.set(
    'access_token',
    tokens.access_token,
    cookieAttrs(tokens.expires_in ?? DEFAULT_ACCESS_TTL_SEC),
  )
  if (tokens.refresh_token) {
    res.cookies.set('refresh_token', tokens.refresh_token, cookieAttrs(REFRESH_TTL_SEC))
  }
}

/**
 * Renew the session of a request whose access token is gone or invalid.
 * Returns the new tokens, or null when there is nothing to renew with or
 * the provider refused. The request's own cookie jar is updated in place
 * so the handlers downstream — which read `access_token` off the request
 * — see the renewed token on this very request.
 */
export async function renewSession(request: NextRequest): Promise<RefreshedTokens | null> {
  const refreshToken = request.cookies.get('refresh_token')?.value
  if (!refreshToken) return null
  const tokens = await refreshAccessToken(refreshToken)
  if (!tokens) return null
  request.cookies.set('access_token', tokens.access_token)
  if (tokens.refresh_token) request.cookies.set('refresh_token', tokens.refresh_token)
  return tokens
}
