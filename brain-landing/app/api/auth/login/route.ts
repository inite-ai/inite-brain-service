import { NextRequest, NextResponse } from 'next/server'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '@/lib/pkce'

/**
 * GET /api/auth/login?return_url=/en/admin/graph
 *
 * Kicks off the OAuth Authorization Code + PKCE flow against auth.inite.ai.
 * The `state` + `code_verifier` + `return_url` are stashed in short-lived
 * HttpOnly cookies so the /callback handler can rehydrate them — we don't
 * have Prisma here, and serverless restarts make in-memory state unsafe.
 * Cookies are scoped to /api/auth so they only leak where they're read.
 */

const AUTH_PUBLIC_URL =
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL || 'https://auth.inite.ai'

const CLIENT_ID =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

// brain:* scopes ride the session token so the BFF can RFC 8693-exchange
// it for an aud=brain token that keeps the user's identity (org + sub).
// Scope is authority ceiling, not role: admin routes still require the
// admin role (middleware + withAdmin), and the exchange narrows per proxy
// (USER_SCOPE vs ADMIN_SCOPE).
const SCOPE =
  process.env.OAUTH_SCOPE ||
  'openid profile email brain:read brain:write brain:admin brain:read_pii'

function appOrigin(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  if (!host) throw new Error('Cannot derive app origin: no host header')
  return `${proto}://${host}`
}

export async function GET(request: NextRequest) {
  const rawReturn =
    request.nextUrl.searchParams.get('return_url') || '/en/admin/graph'
  const returnUrl =
    rawReturn.startsWith('/') && !rawReturn.startsWith('//')
      ? rawReturn
      : '/en/admin/graph'

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const redirectUri = `${appOrigin(request)}/api/auth/callback`

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  const res = NextResponse.redirect(
    `${AUTH_PUBLIC_URL}/oauth/authorize?${params.toString()}`,
  )

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: 10 * 60, // 10 minutes — must exceed user's login time
  }
  res.cookies.set('oauth_state', state, cookieOpts)
  res.cookies.set('oauth_code_verifier', codeVerifier, cookieOpts)
  res.cookies.set('oauth_return_url', returnUrl, cookieOpts)
  return res
}
