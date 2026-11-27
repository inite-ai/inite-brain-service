/**
 * `/api/auth/demo`: the demo grant is made server-side, behind a
 * per-visitor bucket; only a demo token of the demo tenant signs a visitor
 * in, with the access cookie only (no refresh token) and the readable
 * demo_session cookie. Off unless DEMO_ENABLED=1.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const DEMO_ORG = 'a7a71c00-de00-4000-8000-000000000001'
vi.mock('@/lib/jwt-verify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/jwt-verify')>()
  return {
    ...real,
    verifyAccessToken: vi.fn(async (token: string) => {
      if (token === 'DEMO-TOKEN') {
        return { sub: 'ana', demo: true, org_id: DEMO_ORG, org_role: 'owner' }
      }
      if (token === 'OTHER-ORG-DEMO') return { sub: 'x', demo: true, org_id: 'acme' }
      if (token === 'REAL-TOKEN') return { sub: 'mike', roles: ['admin'] }
      return null
    }),
  }
})

process.env.OAUTH_CLIENT_SECRET = 'test-secret'
process.env.OAUTH_CLIENT_ID = 'brain-landing'
process.env.AUTH_SERVICE_URL = 'https://auth.test'
process.env.NEXT_PUBLIC_APP_URL = 'https://brain.test'

let route: typeof import('@/app/api/auth/demo/route')
let issued = 'DEMO-TOKEN'
let grantBodies: URLSearchParams[] = []

beforeAll(async () => {
  route = await import('@/app/api/auth/demo/route')
})

beforeEach(() => {
  process.env.DEMO_ENABLED = '1'
  issued = 'DEMO-TOKEN'
  grantBodies = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('/oauth/token')) throw new Error(`unexpected fetch ${String(url)}`)
    grantBodies.push(new URLSearchParams(String(init?.body ?? '')))
    return new Response(JSON.stringify({ access_token: issued, expires_in: 7200 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

let ipSeq = 0
function req(query: string, ip = `10.0.0.${++ipSeq}`): NextRequest {
  return new NextRequest(`https://brain.test/api/auth/demo${query}`, {
    headers: { 'x-forwarded-for': ip },
  })
}

describe('/api/auth/demo', () => {
  it('is a 404 unless DEMO_ENABLED=1, and asks auth nothing', async () => {
    delete process.env.DEMO_ENABLED
    const res = await route.GET(req('?persona=owner'))
    expect(res.status).toBe(404)
    expect(grantBodies).toHaveLength(0)
  })

  it('refuses a persona that is not one', async () => {
    const res = await route.GET(req('?persona=admin'))
    expect(res.status).toBe(400)
    expect(grantBodies).toHaveLength(0)
  })

  it('makes the demo grant server-side as the confidential client', async () => {
    await route.GET(req('?persona=manager'))
    expect(grantBodies).toHaveLength(1)
    const b = grantBodies[0]!
    expect(b.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(b.get('subject_token_type')).toBe('urn:inite:params:oauth:token-type:demo-persona')
    expect(b.get('subject_token')).toBe('demo:manager')
    expect(b.get('client_id')).toBe('brain-landing')
    expect(b.get('client_secret')).toBe('test-secret')
  })

  it('signs in with the access cookie only, clears refresh, writes demo_session', async () => {
    const before = Math.floor(Date.now() / 1000)
    const res = await route.GET(req('?return_to=/ru/app/demo'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://brain.test/ru/app/demo')
    expect(res.cookies.get('access_token')?.value).toBe('DEMO-TOKEN')
    expect(res.cookies.get('access_token')?.httpOnly).toBe(true)
    expect(res.cookies.get('refresh_token')?.value).toBe('')
    expect(res.cookies.get('refresh_token')?.maxAge).toBe(0)
    const end = Number(res.cookies.get('demo_session')?.value)
    expect(end).toBeGreaterThanOrEqual(before + 7200)
    expect(res.cookies.get('demo_session')?.httpOnly).toBe(false)
    expect(grantBodies[0]!.get('subject_token')).toBe('demo:owner')
  })

  it('ignores an off-site return_to', async () => {
    const res = await route.GET(req('?return_to=//evil.example.com/x'))
    expect(res.headers.get('location')).toBe('https://brain.test/en/app/demo')
  })

  it('refuses a token that is not a demo token of the demo tenant', async () => {
    for (const token of ['REAL-TOKEN', 'OTHER-ORG-DEMO']) {
      issued = token
      const res = await route.GET(req('?persona=owner'))
      expect(res.headers.get('location')).toContain('auth_error=demo_unavailable')
      expect(res.cookies.get('access_token')).toBeUndefined()
    }
  })

  it('holds a per-visitor bucket: five a minute from one address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await route.GET(req('?persona=owner', '192.0.2.7'))).status)
    expect(statuses.slice(0, 5).every((s) => s === 307)).toBe(true)
    expect(statuses[5]).toBe(429)
    expect(grantBodies).toHaveLength(5)
  })
})
