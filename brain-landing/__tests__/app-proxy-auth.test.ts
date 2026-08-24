/**
 * Authorization guard rails for the end-user BFF (`/api/app/proxy`).
 *
 * Regression coverage for the P0 fixed here: on token-exchange failure the
 * BFF must NOT fall back to the tenant-wide M2M credential (which the brain
 * backend lets assert ANY userId), and a client must not be able to pin the
 * request to another user's slice by passing its own `userId`.
 *
 * The whole chain runs for real (route → brainFetch → getBrainToken); only
 * the JWT verifier (session) and the network (`fetch`) are stubbed, so these
 * assert the actual fail-closed behaviour rather than a mock of it.
 */
import { describe, it, expect, beforeAll, vi, type Mock } from 'vitest'
import { NextRequest } from 'next/server'

// `server-only` throws outside a server bundling context; neutralise it so
// the server modules under test import in the node test environment.
vi.mock('server-only', () => ({}))

// Fixed session: every request in this suite is user "alice". `isAdmin`
// stays false — the end-user surface, not the admin panel.
const SESSION_USER = 'alice-user-id'
vi.mock('@/lib/jwt-verify', () => ({
  verifyAccessToken: vi.fn(async () => ({
    sub: SESSION_USER,
    email: 'alice@test.com',
  })),
  isAdminFromToken: () => false,
}))

// brain-api reads these at module load — set before the dynamic import.
process.env.BRAIN_APP_ENABLED = '1'
process.env.OAUTH_CLIENT_SECRET = 'test-secret'
process.env.OAUTH_CLIENT_ID = 'brain-landing'
process.env.AUTH_SERVICE_URL = 'https://auth.test'
process.env.BRAIN_API_URL = 'https://brain.test'

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const CLIENT_CREDENTIALS_GRANT = 'client_credentials'

type Route = typeof import('@/app/api/app/proxy/[...path]/route')
let route: Route

beforeAll(async () => {
  route = await import('@/app/api/app/proxy/[...path]/route')
})

/** Stub `fetch`: auth-service token endpoint + brain backend. */
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
      // client_credentials (anonymous, tenant-wide M2M) mint.
      return json({ access_token: 'M2M-TOKEN', expires_in: 300 })
    }
    if (u.includes('brain.test')) {
      return json({ ok: true, url: u })
    }
    throw new Error(`unexpected fetch to ${u}`)
  })
  globalThis.fetch = f as unknown as typeof fetch
  return f
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function backendCalls(f: Mock): unknown[][] {
  return f.mock.calls.filter(([u]) => String(u).includes('brain.test'))
}

function tokenCalls(f: Mock, grant: string): unknown[][] {
  return f.mock.calls.filter(
    ([u, init]) =>
      String(u).includes('/oauth/token') &&
      new URLSearchParams(
        ((init as RequestInit | undefined)?.body as URLSearchParams) ?? '',
      ).get('grant_type') === grant,
  )
}

// Monotonic across the whole file: every request gets a globally-unique
// session token so brain-api's per-token exchange cache never bleeds a
// success from one test into another.
let seq = 0
/** Unique session cookie token per request → isolate the exchange cache. */
function req(
  path: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  const token = `session-token-${++seq}`
  const headers: Record<string, string> = { cookie: `access_token=${token}` }
  if (init?.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`https://app.local/api/app/proxy/${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

describe('end-user proxy — fail-closed token exchange', () => {
  it('denies (403) and never mints/uses an M2M token when the exchange fails', async () => {
    const f = stubFetch({ exchangeOk: false })

    const res = await route.GET(req('v1/stats/overview?userId=someone-else'))

    // Fail closed: authorization error, not a silent downgrade.
    expect(res.status).toBe(403)

    // Stable, client-safe error shape: a fixed code + a generic message.
    // Backend / auth-service internals must never reach the browser.
    const body = (await res.json()) as { code?: string; error?: string }
    expect(body.code).toBe('identity_exchange_failed')
    expect(body.error).toBe('Not authorized for this request.')
    const serialized = JSON.stringify(body)
    // The auth-service's raw failure text (status/body from the token
    // endpoint) is logged server-side only — it must not leak downstream.
    expect(serialized).not.toContain('exchange grant denied')
    expect(serialized).not.toContain('token exchange failed')
    expect(serialized).not.toContain('M2M')

    // The anonymous, tenant-wide M2M credential was never minted…
    expect(tokenCalls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)
    // …and the backend was never hit with an elevated credential.
    expect(backendCalls(f)).toHaveLength(0)
    // The only outbound call was the (failed) identity-preserving exchange.
    expect(tokenCalls(f, TOKEN_EXCHANGE_GRANT)).toHaveLength(1)
  })
})

describe('end-user proxy — userId is pinned to the session user', () => {
  it('overrides a client-supplied ?userId= in the query with the session user', async () => {
    const f = stubFetch({ exchangeOk: true })

    const res = await route.GET(req('v1/stats/overview?userId=someone-else'))

    expect(res.status).toBe(200)
    const [backendUrl] = backendCalls(f)[0] as [string, RequestInit]
    expect(new URL(backendUrl).searchParams.get('userId')).toBe(SESSION_USER)
  })

  it('overrides a client-supplied userId in the body with the session user', async () => {
    const f = stubFetch({ exchangeOk: true })

    const res = await route.POST(
      req('v1/search?userId=query-attacker', {
        method: 'POST',
        body: { query: 'hello', userId: 'body-attacker' },
      }),
    )

    expect(res.status).toBe(200)
    const [backendUrl, backendInit] = backendCalls(f)[0] as [
      string,
      RequestInit,
    ]
    // Both surfaces are neutralised.
    expect(new URL(backendUrl).searchParams.get('userId')).toBe(SESSION_USER)
    expect(JSON.parse(backendInit.body as string).userId).toBe(SESSION_USER)
  })
})

describe('end-user proxy — happy path unchanged', () => {
  it('forwards the exchanged bearer to the backend (no M2M mint)', async () => {
    const f = stubFetch({ exchangeOk: true })

    const res = await route.GET(req('v1/stats/overview'))

    expect(res.status).toBe(200)
    expect(tokenCalls(f, TOKEN_EXCHANGE_GRANT)).toHaveLength(1)
    expect(tokenCalls(f, CLIENT_CREDENTIALS_GRANT)).toHaveLength(0)

    const [, backendInit] = backendCalls(f)[0] as [string, RequestInit]
    const auth = (backendInit.headers as Record<string, string>).Authorization
    expect(auth).toBe('Bearer EXCHANGED-TOKEN')
  })
})
