import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'

/**
 * Edge guard for /(en|ru)/admin/** and /(en|ru)/app/**.
 *
 * Strategy: lightweight JWT verify on the edge (signature + audience).
 *   - /admin/**: requires a token whose `isAdmin` is true.
 *   - /app/**:   requires any valid token (the end-user product shell).
 * On a missing/invalid (or non-admin, for /admin) token we redirect
 * into the OAuth init flow (`/api/auth/login?return_url=...`). The init
 * endpoint generates PKCE and bounces the user to auth.inite.ai.
 *
 * ADMIN_DEV_BYPASS=1 short-circuits the JWT check entirely. Never
 * enable in production.
 */

const ADMIN_PATH_RE = /^\/(en|ru)?\/?admin(\/|$)/
const APP_PATH_RE = /^\/(en|ru)?\/?app(\/|$)/

const AUTH_DOMAIN =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const EXPECTED_AUDIENCE =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const JWKS = createRemoteJWKSet(new URL('/.well-known/jwks.json', AUTH_DOMAIN))

function appOrigin(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  const host =
    req.headers.get('x-forwarded-host') || req.headers.get('host')
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  return host ? `${proto}://${host}` : 'https://brain.inite.ai'
}

function loginRedirect(req: NextRequest): NextResponse {
  const returnUrl = `${req.nextUrl.pathname}${req.nextUrl.search}`
  const url = new URL('/api/auth/login', appOrigin(req))
  url.searchParams.set('return_url', returnUrl)
  return NextResponse.redirect(url)
}

async function verifyToken(
  token: string,
): Promise<{ valid: boolean; isAdmin: boolean }> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: EXPECTED_AUDIENCE,
      algorithms: ['RS256'],
    })
    const roles = (payload.roles as string[] | undefined) ?? []
    const metadataIsAdmin =
      (payload.metadata as { isAdmin?: boolean } | undefined)?.isAdmin === true
    return { valid: true, isAdmin: roles.includes('admin') || metadataIsAdmin }
  } catch {
    return { valid: false, isAdmin: false }
  }
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname

  const isAdminPath = ADMIN_PATH_RE.test(pathname)
  const isAppPath = APP_PATH_RE.test(pathname)
  if (!isAdminPath && !isAppPath) {
    return NextResponse.next()
  }

  // Dev escape hatch — fails closed in production (mirrors devBypass in
  // lib/server-auth.ts) so a leaked flag can't disable the edge guard.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ADMIN_DEV_BYPASS === '1'
  ) {
    return NextResponse.next()
  }

  const token = req.cookies.get('access_token')?.value
  if (!token) {
    return loginRedirect(req)
  }

  const { valid, isAdmin } = await verifyToken(token)
  // /app/** needs any valid session; /admin/** additionally needs admin.
  if (!valid || (isAdminPath && !isAdmin)) {
    return loginRedirect(req)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/en/admin/:path*',
    '/ru/admin/:path*',
    '/app/:path*',
    '/en/app/:path*',
    '/ru/app/:path*',
  ],
}
