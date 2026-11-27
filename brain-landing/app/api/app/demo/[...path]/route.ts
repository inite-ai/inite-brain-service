import { NextRequest, NextResponse } from 'next/server'
import { withUser, type UserSession } from '@/lib/server-auth'
import { brainFetch } from '@/lib/brain-api'
import { extractProxyPath } from '@/lib/bff-proxy'
import { demoEnabled } from '@/lib/demo-tenant'
import { clientIp, minuteBuckets } from '@/lib/demo-bucket'

/**
 * /api/app/demo/[...path] — the demo workspace's BFF.
 *
 * A demo persona (signed in through `/api/auth/demo`) reads Ana's
 * workspace at «Atlântica Group (demo)» here, and only here:
 *   - GET `graph` → brain `GET /v1/demo/workspace/graph`;
 *   - POST `chat` → brain `POST /v1/demo/workspace/chat` (a question,
 *     answered from the graph; brain's demo chat writes nothing and calls
 *     no model).
 * Nothing else is forwarded: no ingest, no record_fact, no key, no admin
 * path. The backend reads the demo tenant (DEMO_ORG_ID) whoever calls, so
 * the call rides the landing's own service credential with `brain:read`
 * alone — never the visitor's token, never a write scope.
 *
 * Off unless DEMO_ENABLED=1; a non-demo session gets 403.
 */

const ROUTE_PREFIX = '/api/app/demo/'
const DEMO_READ_SCOPE = 'brain:read'
const MAX_MESSAGE = 500

// Every demo visitor reaches brain over the landing's one credential, so
// the per-visitor cap lives here: 20 questions a minute per address.
const chatBuckets = minuteBuckets(20, 600)

const ROUTES: Record<string, { method: 'GET' | 'POST'; backend: string }> = {
  graph: { method: 'GET', backend: '/v1/demo/workspace/graph' },
  chat: { method: 'POST', backend: '/v1/demo/workspace/chat' },
}

async function forward(session: UserSession, request: NextRequest): Promise<NextResponse> {
  if (!demoEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!session.demo) {
    return NextResponse.json({ error: 'demo sessions only' }, { status: 403 })
  }
  const sub = extractProxyPath(request, ROUTE_PREFIX).join('/')
  const route = ROUTES[sub]
  if (!route) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (request.method !== route.method) {
    return NextResponse.json(
      { error: 'The demo is read-only', code: 'demo_read_only' },
      { status: 405 },
    )
  }

  let body: { message: string } | undefined
  if (route.method === 'POST') {
    const retry = chatBuckets.take(clientIp(request.headers))
    if (retry) {
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(retry) } },
      )
    }
    const raw = (await request.json().catch(() => null)) as { message?: unknown } | null
    const message = typeof raw?.message === 'string' ? raw.message.trim() : ''
    if (!message || message.length > MAX_MESSAGE) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }
    body = { message }
  }

  const res = await brainFetch(route.backend, {
    method: route.method,
    body,
    scope: DEMO_READ_SCOPE,
  })
  return NextResponse.json(res.data ?? { error: res.error, code: res.code }, {
    status: res.status || (res.ok ? 200 : 502),
  })
}

export const GET = withUser(forward)
export const POST = withUser(forward)
