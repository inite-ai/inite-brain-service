// Hard server-only gate. Importing this file from a 'use client'
// component fails the Next.js build — server-only's module
// initialisation throws under client bundling. Prevents the M2M
// admin credentials in here from ever being bundled into JS sent
// to the browser.
import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAccessToken, isAdminFromToken } from './jwt-verify'

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

export async function getAdminSession(
  request: NextRequest,
): Promise<AdminSession | null> {
  const bypass = devBypass()
  if (bypass) return bypass

  const token = await extractAccessToken(request)
  if (!token) return null

  const decoded = await verifyAccessToken(token)
  if (!decoded) return null
  if (!isAdminFromToken(decoded)) return null

  return {
    userId: decoded.sub,
    email: (decoded.email as string) ?? null,
    isAdmin: true,
  }
}

/**
 * Like {@link getAdminSession} but does NOT require admin. Returns a
 * session for any valid OAuth token (audience='brain-landing'). The
 * dev-bypass still applies so local development without auth works.
 */
export async function getUserSession(
  request: NextRequest,
): Promise<UserSession | null> {
  const bypass = devBypass()
  if (bypass) return bypass

  const token = await extractAccessToken(request)
  if (!token) return null

  const decoded = await verifyAccessToken(token)
  if (!decoded) return null

  return {
    userId: decoded.sub,
    email: (decoded.email as string) ?? null,
    isAdmin: isAdminFromToken(decoded),
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
    const session = await getUserSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return handler(session, request)
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
    const session = await getAdminSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return handler(session, request)
  }
}
