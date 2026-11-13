import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { clientIp, minuteBuckets } from './demo-bucket'
import {
  DEMO_GRANT_TYPE,
  DEMO_SESSION_COOKIE,
  DEMO_SUBJECT_TOKEN_TYPE,
  demoEnabled,
  demoPersona,
} from './demo-tenant'
import { isDemoTenantToken, verifyAccessToken } from './jwt-verify'

/**
 * `/api/auth/demo?persona=owner|manager|staff&return_to=/en/app/demo`
 *
 * The landing's own version of @inite/auth's demo door (this repo is
 * public and takes no private package). Server-side, as the brain-landing
 * confidential client, it asks auth.inite.ai for a demo persona of
 * «Atlântica Group (demo)» (RFC 8693, subject `demo:<persona>`), checks the
 * answer is a demo token of the demo tenant, and signs the visitor in with
 * it:
 *   - the access cookie only. Auth issues no refresh token for a demo, and
 *     whatever refresh token the browser held is cleared, so nothing can
 *     bring an earlier session back or outlive the demo;
 *   - `demo_session=<end, Unix seconds>`, readable, for the banner.
 *
 * Off unless DEMO_ENABLED=1 (then a 404). In front of the grant sits a
 * per-visitor bucket: 5 a minute per address, 30 a minute for the whole
 * process (auth's own per-client limit).
 */

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ||
  'https://auth.inite.ai'

const CLIENT_ID =
  process.env.OAUTH_CLIENT_ID ||
  process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ||
  'brain-landing'

const DEMO_TTL_FALLBACK_SEC = 7200

const buckets = minuteBuckets(5, 30)

function appOrigin(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  return host ? `${proto}://${host}` : 'https://brain.inite.ai'
}

/** A same-origin path, or null. */
export function safeReturnPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  return raw
}

function failTo(request: NextRequest, returnTo: string, reason: string): NextResponse {
  const url = new URL(returnTo, appOrigin(request))
  url.searchParams.set('auth_error', reason)
  return NextResponse.redirect(url)
}

async function requestDemoToken(
  persona: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const secret = process.env.OAUTH_CLIENT_SECRET || ''
  if (!secret) {
    console.error('[demo] OAUTH_CLIENT_SECRET is not configured')
    return null
  }
  let res: Response
  try {
    res = await fetch(`${AUTH_SERVICE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: DEMO_GRANT_TYPE,
        subject_token_type: DEMO_SUBJECT_TOKEN_TYPE,
        subject_token: `demo:${persona}`,
        client_id: CLIENT_ID,
        client_secret: secret,
      }),
    })
  } catch {
    console.error('[demo] demo grant: auth unreachable')
    return null
  }
  if (!res.ok) {
    console.error('[demo] demo grant refused:', res.status)
    return null
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
  } | null
  if (!body?.access_token) return null
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? DEMO_TTL_FALLBACK_SEC,
  }
}

export async function demoSignIn(request: NextRequest): Promise<NextResponse> {
  if (!demoEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const params = request.nextUrl.searchParams
  const lang = params.get('lang') === 'ru' ? 'ru' : 'en'
  const returnTo =
    safeReturnPath(params.get('return_to') ?? params.get('returnTo')) ?? `/${lang}/app/demo`
  const persona = demoPersona(params.get('persona') ?? 'owner')
  if (!persona) return NextResponse.json({ error: 'invalid_persona' }, { status: 400 })

  const retry = buckets.take(clientIp(request.headers))
  if (retry) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retry) } },
    )
  }

  const grant = await requestDemoToken(persona)
  if (!grant) return failTo(request, returnTo, 'demo_unavailable')
  // Only a demo token of the demo tenant signs a visitor in through this
  // door: anything else auth might answer is refused, not trusted.
  const verified = await verifyAccessToken(grant.accessToken)
  if (!verified || !isDemoTenantToken(verified)) {
    console.error('[demo] the grant did not return a demo token of the demo tenant')
    return failTo(request, returnTo, 'demo_unavailable')
  }

  const secure = process.env.NODE_ENV === 'production'
  const res = NextResponse.redirect(new URL(returnTo, appOrigin(request)))
  res.cookies.set('access_token', grant.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: grant.expiresIn,
  })
  res.cookies.set('refresh_token', '', { path: '/', maxAge: 0 })
  res.cookies.set(DEMO_SESSION_COOKIE, String(Math.floor(Date.now() / 1000) + grant.expiresIn), {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: grant.expiresIn,
  })
  return res
}
