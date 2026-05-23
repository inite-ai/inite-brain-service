import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/auth/callback?code=...&state=...
 *
 * Sink for auth.inite.ai authorization redirect. Validates state, swaps
 * the code for an access_token via /oauth/token (Authorization Code +
 * PKCE), drops the JWT into an HttpOnly cookie, and bounces the user
 * back to the originally-requested return URL.
 */

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const CLIENT_ID =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || ''

function appOrigin(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  const host =
    request.headers.get('x-forwarded-host') || request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  if (!host) throw new Error('Cannot derive app origin: no host header')
  return `${proto}://${host}`
}

function fail(request: NextRequest, message: string, status = 400) {
  const url = new URL('/auth/error', appOrigin(request))
  url.searchParams.set('reason', message)
  return NextResponse.redirect(url, status === 400 ? 302 : status)
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const oauthError = request.nextUrl.searchParams.get('error')

  if (oauthError) {
    return fail(request, oauthError)
  }
  if (!code || !state) {
    return fail(request, 'missing_code_or_state')
  }
  if (!CLIENT_SECRET) {
    return fail(request, 'server_missing_client_secret', 500)
  }

  const expectedState = request.cookies.get('oauth_state')?.value
  const codeVerifier = request.cookies.get('oauth_code_verifier')?.value
  const returnUrl =
    request.cookies.get('oauth_return_url')?.value || '/en/admin/graph'

  if (!expectedState || expectedState !== state) {
    return fail(request, 'state_mismatch')
  }
  if (!codeVerifier) {
    return fail(request, 'missing_code_verifier')
  }

  const redirectUri = `${appOrigin(request)}/api/auth/callback`

  const tokenRes = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('[oauth callback] token exchange failed:', tokenRes.status, errText)
    return fail(request, `token_exchange_${tokenRes.status}`)
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const origin = appOrigin(request)
  const dest = returnUrl.startsWith('/')
    ? new URL(returnUrl, origin)
    : new URL('/en/admin/graph', origin)
  const res = NextResponse.redirect(dest)

  res.cookies.set('access_token', tokens.access_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: tokens.expires_in ?? 60 * 60 * 8,
  })
  if (tokens.refresh_token) {
    res.cookies.set('refresh_token', tokens.refresh_token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    })
  }

  // Clear the PKCE crumbs so they aren't reused.
  for (const c of ['oauth_state', 'oauth_code_verifier', 'oauth_return_url']) {
    res.cookies.set(c, '', { path: '/api/auth', maxAge: 0 })
  }

  return res
}
