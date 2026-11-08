/**
 * A demo session is read-only end to end: the end-user BFF refuses it
 * (writes 403 demo_read_only), and the demo BFF forwards exactly two calls
 * — the graph and a question — to brain's demo workspace, over the
 * landing's own credential with `brain:read` alone.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const DEMO_ORG = 'a7a71c00-de00-4000-8000-000000000001'
let claims: Record<string, unknown> = {}
vi.mock('@/lib/jwt-verify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/jwt-verify')>()
  return { ...real, verifyAccessToken: vi.fn(async () => claims) }
})

process.env.BRAIN_APP_ENABLED = '1'
process.env.OAUTH_CLIENT_SECRET = 'test-secret'
process.env.OAUTH_CLIENT_ID = 'brain-landing'
process.env.AUTH_SERVICE_URL = 'https://auth.test'
process.env.BRAIN_API_URL = 'https://brain.test'

let appProxy: typeof import('@/app/api/app/proxy/[...path]/route')
let demoProxy: typeof import('@/app/api/app/demo/[...path]/route')
let f: Mock

beforeAll(async () => {
  appProxy = await import('@/app/api/app/proxy/[...path]/route')
  demoProxy = await import('@/app/api/app/demo/[...path]/route')
})

beforeEach(() => {
  process.env.DEMO_ENABLED = '1'
  claims = { sub: 'ana-demo', demo: true, org_id: DEMO_ORG, org_role: 'owner' }
  f = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'M2M', expires_in: 300 }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  globalThis.fetch = f as unknown as typeof fetch
})

function req(path: string, method = 'GET', body?: unknown, ip = '198.51.100.1'): NextRequest {
  return new NextRequest(`https://brain.test${path}`, {
    method,
    headers: {
      cookie: 'access_token=DEMO',
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const brainCalls = () => f.mock.calls.filter(([u]) => String(u).startsWith('https://brain.test'))
const grants = () =>
  f.mock.calls
    .filter(([u]) => String(u).includes('/oauth/token'))
    .map(([, init]) => new URLSearchParams(String((init as RequestInit).body)))

describe('the end-user BFF refuses a demo session', () => {
  it('writes: 403 demo_read_only, nothing reaches brain', async () => {
    for (const p of ['v1/ingest/fact', 'v1/ingest/mention', 'v1/keys', 'v1/facts/x/retract']) {
      const res = await appProxy.POST(req(`/api/app/proxy/${p}`, 'POST', { a: 1 }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('demo_read_only')
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('reads of a real tenant: 403, nothing reaches brain', async () => {
    const res = await appProxy.GET(req('/api/app/proxy/v1/search?q=x'))
    expect(res.status).toBe(403)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('/api/app/demo', () => {
  it('reads the graph over the landing credential, brain:read only, no exchange', async () => {
    const res = await demoProxy.GET(req('/api/app/demo/graph'))
    expect(res.status).toBe(200)
    expect(brainCalls().map(([u]) => String(u))).toEqual(['https://brain.test/v1/demo/workspace/graph'])
    const g = grants()
    expect(g.map((b) => b.get('grant_type'))).toEqual(['client_credentials'])
    expect(g[0]!.get('scope')).toBe('brain:read')
  })

  it('forwards a question and nothing else', async () => {
    const res = await demoProxy.POST(req('/api/app/demo/chat', 'POST', { message: ' Who is Bruno? ', userId: 'x' }))
    expect(res.status).toBe(200)
    const [url, init] = brainCalls()[0]!
    expect(String(url)).toBe('https://brain.test/v1/demo/workspace/chat')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ message: 'Who is Bruno?' })
  })

  it('has no write path', async () => {
    expect((await demoProxy.POST(req('/api/app/demo/graph', 'POST', {}))).status).toBe(405)
    expect((await demoProxy.GET(req('/api/app/demo/chat'))).status).toBe(405)
    expect((await demoProxy.POST(req('/api/app/demo/v1/ingest/fact', 'POST', {}))).status).toBe(404)
    expect((await demoProxy.POST(req('/api/app/demo/chat', 'POST', { message: '' }))).status).toBe(400)
    expect(brainCalls()).toHaveLength(0)
  })

  it('is for demo sessions only, and off unless DEMO_ENABLED=1', async () => {
    claims = { sub: 'mike', roles: ['admin'] }
    expect((await demoProxy.GET(req('/api/app/demo/graph'))).status).toBe(403)
    claims = { sub: 'ana-demo', demo: true, org_id: DEMO_ORG }
    delete process.env.DEMO_ENABLED
    expect((await demoProxy.GET(req('/api/app/demo/graph'))).status).toBe(404)
    expect(brainCalls()).toHaveLength(0)
  })

  it('caps questions per visitor', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      statuses.push((await demoProxy.POST(req('/api/app/demo/chat', 'POST', { message: 'q' }, '203.0.113.9'))).status)
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20)
    expect(statuses[20]).toBe(429)
  })
})
