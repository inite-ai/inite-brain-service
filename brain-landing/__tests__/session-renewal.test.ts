/**
 * Silent session renewal (lib/token-refresh.ts, wired into lib/server-auth
 * and middleware.ts).
 *
 * The OAuth callback stored a seven-day `refresh_token` cookie that
 * nothing ever read: when the five-minute `access_token` expired, the BFF
 * answered 401 and the edge guard bounced to a consent screen. These pin
 * the renewed path end to end through the real `withAdmin` / `withUser`
 * wrappers, with only the JWT verifier and `fetch` stubbed:
 *  - no/invalid access token + refresh cookie → the refresh grant runs, the
 *    handler sees the new token on the request, the response carries the
 *    renewed cookies;
 *  - a valid access token never refreshes; a provider refusal is a 401
 *    exactly as before; a Bearer header is the caller's own credential and
 *    is never refreshed;
 *  - the edge guard renews a page load the same way and keeps the admin
 *    check on the fresh token.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('server-only', () => ({}))

const VALID = new Set<string>()
vi.mock('@/lib/jwt-verify', () => ({
  verifyAccessToken: vi.fn(async (token: string) =>
    VALID.has(token) ? { sub: 'alice', email: 'alice@test.com', roles: ['admin'] } : null,
  ),
  isAdminFromToken: (d: { roles?: string[] }) => d.roles?.includes('admin') === true,
}))
// The middleware verifies with jose directly; make it recognise the same tokens.
vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string) => {
    if (!VALID.has(token)) throw new Error('bad token')
    return { payload: { sub: 'alice', roles: ['admin'] } }
  },
}))

process.env.OAUTH_CLIENT_SECRET = 'test-secret'
process.env.OAUTH_CLIENT_ID = 'brain-landing'
process.env.AUTH_SERVICE_URL = 'https://auth.test'

function stubFetch(refresh: 'ok' | 'denied'): Mock {
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (!u.includes('/oauth/token')) throw new Error(`unexpected fetch to ${u}`)
    const params = new URLSearchParams((init?.body as URLSearchParams | undefined) ?? '')
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('client_secret')).toBe('test-secret')
    if (refresh === 'denied') return new Response('invalid_grant', { status: 400 })
    VALID.add('FRESH-ACCESS')
    return new Response(
      JSON.stringify({ access_token: 'FRESH-ACCESS', refresh_token: 'FRESH-REFRESH', expires_in: 300 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  globalThis.fetch = f as unknown as typeof fetch
  return f
}

function req(cookies: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return new NextRequest('https://app.local/api/admin/proxy/v1/health', {
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  })
}

function setCookie(res: NextResponse, name: string): string | undefined {
  return res.cookies.get(name)?.value
}

beforeEach(() => {
  VALID.clear()
  VALID.add('LIVE-ACCESS')
})

describe('withAdmin — silent renewal', () => {
  it('renews an expired session: the handler runs with the fresh token and the response re-sets the cookies', async () => {
    const f = stubFetch('ok')
    const { withAdmin, extractAccessToken } = await import('@/lib/server-auth')
    let seen: string | null = null
    const handler = withAdmin(async (session, request) => {
      seen = await extractAccessToken(request)
      return NextResponse.json({ user: session.userId })
    })
    const res = await handler(req({ refresh_token: 'OLD-REFRESH' }))
    expect(res.status).toBe(200)
    expect(seen).toBe('FRESH-ACCESS')
    expect(setCookie(res, 'access_token')).toBe('FRESH-ACCESS')
    expect(setCookie(res, 'refresh_token')).toBe('FRESH-REFRESH')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a live access token is used as is — no refresh, no cookie churn', async () => {
    const f = stubFetch('ok')
    const { withAdmin } = await import('@/lib/server-auth')
    const handler = withAdmin(async () => NextResponse.json({ ok: true }))
    const res = await handler(req({ access_token: 'LIVE-ACCESS', refresh_token: 'OLD-REFRESH' }))
    expect(res.status).toBe(200)
    expect(f).not.toHaveBeenCalled()
    expect(setCookie(res, 'access_token')).toBeUndefined()
  })

  it('a refused refresh is the 401 it always was; a Bearer credential is never refreshed', async () => {
    const f = stubFetch('denied')
    const { withUser } = await import('@/lib/server-auth')
    const handler = withUser(async () => NextResponse.json({ ok: true }))
    expect((await handler(req({ refresh_token: 'OLD-REFRESH' }))).status).toBe(401)
    expect(f).toHaveBeenCalledTimes(1)
    const bearer = await handler(
      req({ refresh_token: 'OLD-REFRESH' }, { authorization: 'Bearer STALE' }),
    )
    expect(bearer.status).toBe(401)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('middleware — the page load renews too', () => {
  it('an expired access token with a refresh cookie passes through with renewed cookies', async () => {
    stubFetch('ok')
    const { middleware } = await import('@/middleware')
    const request = new NextRequest('https://brain.inite.ai/en/app/playground', {
      headers: { cookie: 'access_token=EXPIRED; refresh_token=OLD-REFRESH' },
    })
    const res = await middleware(request)
    expect(res.status).toBe(200)
    expect(setCookie(res, 'access_token')).toBe('FRESH-ACCESS')
  })

  it('without a refresh cookie, or when the provider refuses, it redirects to login as before', async () => {
    stubFetch('denied')
    const { middleware } = await import('@/middleware')
    const none = await middleware(
      new NextRequest('https://brain.inite.ai/en/admin/graph', { headers: { cookie: 'access_token=EXPIRED' } }),
    )
    expect(none.status).toBe(307)
    expect(none.headers.get('location')).toContain('/api/auth/login')
    const refused = await middleware(
      new NextRequest('https://brain.inite.ai/en/admin/graph', {
        headers: { cookie: 'access_token=EXPIRED; refresh_token=OLD-REFRESH' },
      }),
    )
    expect(refused.status).toBe(307)
  })
})
