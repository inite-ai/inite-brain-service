import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'

/**
 * Edge guard for /(en|ru)/admin/**.
 *
 * Strategy: lightweight JWT verify on the edge (signature + audience).
 * If the token is missing or `isAdmin` is false, redirect to the
 * auth-service login. Server-side API routes (under /api/admin/proxy)
 * re-verify via `server-auth.ts` for defense in depth.
 *
 * ADMIN_DEV_BYPASS=1 lets local devs skip the JWT step entirely. The
 * server-side proxy honors the same flag.
 */

const LANG_RE = /^\/(en|ru)(\/|$)/
const ADMIN_PATH_RE = /^\/(en|ru)?\/?admin(\/|$)/

const AUTH_DOMAIN =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const AUTH_BROWSER_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.inite.ai'

const EXPECTED_AUDIENCE =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const JWKS = createRemoteJWKSet(new URL('/.well-known/jwks.json', AUTH_DOMAIN))

function loginRedirect(req: NextRequest): NextResponse {
  const continueTo = `${req.nextUrl.origin}${req.nextUrl.pathname}${req.nextUrl.search}`
  const url = new URL('/login', AUTH_BROWSER_URL)
  url.searchParams.set('continue', continueTo)
  return NextResponse.redirect(url)
}

async function isAdminToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: EXPECTED_AUDIENCE,
      algorithms: ['RS256'],
    })
    const roles = (payload.roles as string[] | undefined) ?? []
    const metadataIsAdmin =
      (payload.metadata as { isAdmin?: boolean } | undefined)?.isAdmin === true
    return roles.includes('admin') || metadataIsAdmin
  } catch {
    return false
  }
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname

  // Only the admin tree needs gating. Everything else (marketing, docs)
  // is public.
  if (!ADMIN_PATH_RE.test(pathname)) {
    return NextResponse.next()
  }

  // Dev bypass — local kicks straight in.
  if (process.env.ADMIN_DEV_BYPASS === '1') {
    return NextResponse.next()
  }

  const token = req.cookies.get('access_token')?.value
  if (!token) {
    return loginRedirect(req)
  }

  const allowed = await isAdminToken(token)
  if (!allowed) {
    return loginRedirect(req)
  }

  return NextResponse.next()
}

// Match everything that touches the admin tree, plus the unprefixed
// /admin -> /en/admin redirect handled by Next routing itself.
export const config = {
  matcher: ['/admin/:path*', '/en/admin/:path*', '/ru/admin/:path*'],
}
