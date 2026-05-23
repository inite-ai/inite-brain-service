import { NextRequest, NextResponse } from 'next/server'
import { verifyAccessToken, isAdminFromToken } from './jwt-verify'

export interface AdminSession {
  userId: string
  email: string | null
  isAdmin: true
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
 * treated as an admin synthetic user. Never enable in production —
 * `validateEnv` should refuse to start with this flag in prod.
 */
function devBypass(): AdminSession | null {
  if (process.env.ADMIN_DEV_BYPASS !== '1') return null
  return { userId: 'dev-bypass', email: 'dev@local', isAdmin: true }
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
