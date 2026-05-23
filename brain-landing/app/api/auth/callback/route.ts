import { NextRequest, NextResponse } from 'next/server'
import { verifyAccessToken } from '@/lib/jwt-verify'

/**
 * GET /api/auth/callback?token=<jwt>&continue=<url>
 *
 * Sink for auth.inite.ai redirects. Verifies the token, drops it into
 * an HttpOnly cookie, then sends the user back to the original
 * `continue` URL. Auth-service is the source of truth — we never mint
 * a token here, only persist.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  const continueTo = request.nextUrl.searchParams.get('continue') || '/en/admin'

  if (!token) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  const decoded = await verifyAccessToken(token)
  if (!decoded) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  const dest = continueTo.startsWith('/')
    ? new URL(continueTo, request.url)
    : new URL(continueTo)
  const res = NextResponse.redirect(dest)
  res.cookies.set('access_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8, // 8h — typical auth-service access-token ttl
  })
  return res
}
