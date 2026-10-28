/**
 * The admin BFF (`/api/admin/proxy`, `/api/admin/sse`) must fail closed on a
 * refused token exchange, exactly like the end-user proxy
 * (app-proxy-auth.test.ts). Before this, a refused exchange fell back to the
 * client_credentials token: brain:admin + brain:read_pii on brain-landing's
 * own tenant. `withAdmin` admits any token whose `roles` include `admin`,
 * and the auth-service stamps that role on admins scoped to other companies
 * too, so the fallback handed them this tenant.
 *
 * The chain runs for real (route -> brainFetch/getBrainToken); only the
 * session verifier and the network are stubbed.
 */
import { describe, it, expect, beforeAll, vi, type Mock } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/jwt-verify', () => ({
  verifyAccessToken: vi.fn(async () => ({ sub: 'did:key:scoped-admin', roles: ['admin'] })),
  isAdminFromToken: () => true,
}))

process.env.OAUTH_CLIENT_SECRET = 'test-secret'
process.env.OAUTH_CLIENT_ID = 'brain-landing'
process.env.AUTH_SERVICE_URL = 'https://auth.test'
process.env.BRAIN_API_URL = 'https://brain.test'

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const CLIENT_CREDENTIALS_GRANT = 'client_credentials'

type ProxyRoute = typeof import('@/app/api/admin/proxy/[...path]/route')
type SseRoute = typeof import('@/app/api/admin/sse/[...path]/route')
let proxy: ProxyRoute
let sse: SseRoute

beforeAll(async () => {
  proxy = await import('@/app/api/admin/proxy/[...path]/route')
  sse = await import('@/app/api/admin/sse/[...path]/route')
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(opts: { exchangeOk: boolean }): Mock {
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/oauth/token')) {
      const grant = new URLSearchParams(
        (init?.body as URLSearchParams | undefined) ?? '',
      ).get('grant_type')
      if (grant === TOKEN_EXCHANGE_GRANT) {
        return opts.exchangeOk
          ? json({ access_token: 'EXCHANGED-TOKEN', expires_in: 300 })
          : new Response('exchange grant denied', { status: 401 })
      }
      return json({ access_token: 'M2M-TOKEN', expires_in: 300 })
    }
    if (u.includes('brain.test')) {
      return u.includes('/stream')
        ? new Response('data: {}\n\n', { status: 200 })
        : json({ ok: true })
    }
    throw new Error(`unexpected fetch to ${u}`)
  })
  globalThis.fetch = f as unknown as typeof fetch
  return f
}

const calls = (f: Mock, grant: string) =>
  f.mock.calls.filter(
    ([u, init]) =>
      String(u).includes('/oauth/token') &&
      new URLSearchParams(((init as RequestInit | undefined)?.body as URLSearchParams) ?? '').get(
        'grant_type',
      ) === grant,
  )
const backend = (f: Mock) => f.mock.calls.filter(([u]) => String(u).includes('brain.test'))

let seq = 0
function req(prefix: string, path: string, method = 'GET'): NextRequest {
  return new NextRequest(`https://app.local${prefix}${path}`, {
    method,
    headers: { cookie: `access_token=admin-session-${++seq}` },
  })
}

describe('admin proxy: refused exchange fails closed', () => {
  it('answers 403 and never mints or uses the M2M token', async () => {
    const f = stubFetch({ exchangeOk: false })
    const res = await proxy.GET(req('/api/admin/proxy/', 'v1/admin/pii'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('identity_exchange_failed')
    expect(calls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)
    expect(backend(f)).toHaveLength(0)
  })

  it('a destructive call is refused the same way', async () => {
    const f = stubFetch({ exchangeOk: false })
    const res = await proxy.DELETE(req('/api/admin/proxy/', 'v1/admin/tenants/eval_x_1', 'DELETE'))
    expect(res.status).toBe(403)
    expect(calls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)
    expect(backend(f)).toHaveLength(0)
  })

  it('a working exchange still forwards the exchanged bearer', async () => {
    const f = stubFetch({ exchangeOk: true })
    const res = await proxy.GET(req('/api/admin/proxy/', 'v1/admin/pii'))
    expect(res.status).not.toBe(403)
    expect(calls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)
    const [, init] = backend(f)[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EXCHANGED-TOKEN')
  })
})

describe('admin SSE: refused exchange fails closed', () => {
  it('answers 403 without the M2M token or the token-endpoint text', async () => {
    const f = stubFetch({ exchangeOk: false })
    const res = await sse.GET(req('/api/admin/sse/', 'v1/admin/jobs/stream'))
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain('exchange grant denied')
    expect(calls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)
    expect(backend(f)).toHaveLength(0)
  })
})
