// Hard server-only gate. Importing this file from a 'use client'
// component fails the Next.js build — server-only's module
// initialisation throws under client bundling. Prevents the M2M
// admin credentials in here from ever being bundled into JS sent
// to the browser.
import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAccessToken, isAdminFromToken } from './jwt-verify'
import { renewSession, setSessionCookies, type RefreshedTokens } from './token-refresh'

export interface AdminSession {
  userId: string
  email: string | null
  isAdmin: true
}

/**
 * Any authenticated OAuth user (not necessarily an admin). Backs the
 * end-user product UI under `/[lang]/app/**` and its BFF
 * (`/api/app/proxy`). `isAdmin` is surfaced so the UI can reveal
 * admin-only affordances, but it is never required to enter the app.
 */
export interface UserSession {
  userId: string
  email: string | null
  isAdmin: boolean
}

// Sentinel value used by dev-bypass + reused by /api/auth/me.
const DEV_BYPASS_SESSION: AdminSession = {
  userId: 'dev-bypass',
  email: 'dev@local',
  isAdmin: true,
}

export async function extractAccessToken(
  request: NextRequest,
): Promise<string | null> {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  return request.cookies.get('access_token')?.value ?? null
}

/**
 * Dev escape hatch. When `ADMIN_DEV_BYPASS=1` is set, all requests are
 * treated as an admin synthetic user. Fails closed in production: the
 * bypass is ignored when NODE_ENV==='production' regardless of the flag,
 * so a leaked/copied env var can't expose the full-scope admin BFF.
 */
function devBypass(): AdminSession | null {
  if (process.env.NODE_ENV === 'production') return null
  if (process.env.ADMIN_DEV_BYPASS !== '1') return null
  return DEV_BYPASS_SESSION
}

/**
 * The verified token of a request — the one it carries, or, when that is
 * missing or no longer valid, the one a silent refresh just minted (the
 * renewed cookies are reported so the wrapper can set them on the
 * response). Null when neither exists.
 */
async function verifiedSession(request: NextRequest): Promise<{
  decoded: NonNullable<Awaited<ReturnType<typeof verifyAccessToken>>>
  renewed: RefreshedTokens | null
} | null> {
  const token = await extractAccessToken(request)
  const decoded = token ? await verifyAccessToken(token) : null
  if (decoded) return { decoded, renewed: null }
  // A bearer header is the caller's own credential — never refreshed.
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return null
  const renewed = await renewSession(request)
  if (!renewed) return null
  const fresh = await verifyAccessToken(renewed.access_token)
  return fresh ? { decoded: fresh, renewed } : null
}

/**
 * Session read WITHOUT the renewed cookies. For code that cannot set
 * cookies on its response only; a route handler must use `withAdmin`,
 * `withUser` or `withSession`, or a renewal here rotates the refresh
 * token and loses it (see withSession).
 */
export async function getAdminSession(
  request: NextRequest,
): Promise<AdminSession | null> {
  return (await getAdminSessionWithRenewal(request))?.session ?? null
}

async function getAdminSessionWithRenewal(
  request: NextRequest,
): Promise<{ session: AdminSession; renewed: RefreshedTokens | null } | null> {
  const bypass = devBypass()
  if (bypass) return { session: bypass, renewed: null }

  const verified = await verifiedSession(request)
  if (!verified) return null
  const { decoded, renewed } = verified
  if (!isAdminFromToken(decoded)) return null

  return {
    session: {
      userId: decoded.sub,
      email: (decoded.email as string) ?? null,
      isAdmin: true,
    },
    renewed,
  }
}

/**
 * Like {@link getAdminSession} but does NOT require admin. Returns a
 * session for any valid OAuth token (audience='brain-landing'). The
 * dev-bypass still applies so local development without auth works.
 * Same hazard as getAdminSession: route handlers use `withSession`.
 */
export async function getUserSession(
  request: NextRequest,
): Promise<UserSession | null> {
  return (await getUserSessionWithRenewal(request))?.session ?? null
}

async function getUserSessionWithRenewal(
  request: NextRequest,
): Promise<{ session: UserSession; renewed: RefreshedTokens | null } | null> {
  const bypass = devBypass()
  if (bypass) return { session: bypass, renewed: null }

  const verified = await verifiedSession(request)
  if (!verified) return null
  const { decoded, renewed } = verified

  return {
    session: {
      userId: decoded.sub,
      email: (decoded.email as string) ?? null,
      isAdmin: isAdminFromToken(decoded),
    },
    renewed,
  }
}

/** A handler's response, carrying the renewed session cookies when a
 *  silent refresh ran for this request. */
function withRenewedCookies(res: NextResponse, renewed: RefreshedTokens | null): NextResponse {
  if (renewed) setSessionCookies(res, renewed)
  return res
}

/**
 * Wraps a Next.js API handler that answers with or without a session
 * (`/api/auth/me`): the handler gets the session or null and always
 * runs. The point is the cookies: a session getter that renews without
 * a wrapper rotates the refresh token at the provider and then DROPS
 * the new one, so the browser keeps a revoked token and the next renewal
 * is read as theft (the provider revokes the whole family). Every route
 * that can renew must go through a wrapper that sets what was renewed.
 */
export function withSession(
  handler: (
    session: UserSession | null,
    request: NextRequest,
  ) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const resolved = await getUserSessionWithRenewal(request)
    return withRenewedCookies(
      await handler(resolved?.session ?? null, request),
      resolved?.renewed ?? null,
    )
  }
}

/**
 * Wraps a Next.js API handler so it runs for any authenticated user.
 * Returns 401 when there is no valid session. Used by the end-user BFF
 * (`/api/app/proxy`) — access control beyond "is logged in" is enforced
 * by the proxy's allow-list and the reduced M2M scope it requests.
 */
export function withUser(
  handler: (
    session: UserSession,
    request: NextRequest,
  ) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const resolved = await getUserSessionWithRenewal(request)
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return withRenewedCookies(await handler(resolved.session, request), resolved.renewed)
  }
}

/**
 * Wraps a Next.js API handler so it only runs for admins. Returns 401
 * when no session, 403 when session exists but `isAdmin === false`.
 */
export function withAdmin(
  handler: (
    session: AdminSession,
    request: NextRequest,
  ) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const resolved = await getAdminSessionWithRenewal(request)
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return withRenewedCookies(await handler(resolved.session, request), resolved.renewed)
  }
}
