import { NextRequest, NextResponse } from 'next/server'
import { withAdmin, extractAccessToken } from '@/lib/server-auth'
import { getBrainToken, TokenExchangeError } from '@/lib/brain-api'

/**
 * /api/admin/sse/[...path] — admin-gated SSE pass-through.
 *
 * Distinct from the standard JSON proxy because EventSource expects
 * `text/event-stream` and the underlying response cannot be
 * `await res.text()`-ed and re-emitted as JSON. We open the upstream
 * connection, mint the same service-side OAuth token used by the JSON
 * proxy, and pipe the body straight to the browser.
 *
 * Allowlist mirrors the JSON proxy but is intentionally narrower —
 * SSE endpoints are a small fixed set. Anything outside the allowlist
 * rejects with 403.
 */

const ALLOWED_PREFIXES = [
  'v1/admin/traces/stream',
  'v1/admin/jobs/stream',
]

function isAllowed(path: string): boolean {
  const normalized = path.replace(/^\/+/, '').replace(/\?.*$/, '')
  return ALLOWED_PREFIXES.some(
    (p) => normalized === p || normalized.startsWith(p),
  )
}

const SSE_SCOPE =
  process.env.BRAIN_SCOPE || 'brain:read brain:write brain:admin brain:read_pii'

export const GET = withAdmin(async (_session, request) => {
  const u = request.nextUrl
  const prefix = '/api/admin/sse/'
  const subpath = u.pathname.startsWith(prefix)
    ? u.pathname.slice(prefix.length)
    : ''
  if (!isAllowed(subpath)) {
    return NextResponse.json(
      { error: `path '/${subpath}' is not in the SSE allow-list` },
      { status: 403 },
    )
  }
  const target =
    (process.env.BRAIN_API_URL || 'https://brain.inite.ai') +
    `/${subpath}${u.search}`

  let token: string
  try {
    // Same fail-closed, identity-preserving exchange as the JSON proxy:
    // only a request with no user token (dev bypass) gets the M2M token.
    const userToken = await extractAccessToken(request)
    token = await getBrainToken({
      scope: SSE_SCOPE,
      userToken,
      requireUserIdentity: Boolean(userToken),
    })
  } catch (e) {
    if (e instanceof TokenExchangeError) {
      return NextResponse.json(
        { error: 'Not authorized for this request.', code: 'identity_exchange_failed' },
        { status: 403 },
      )
    }
    // Token-endpoint diagnostics stay in the server log.
    console.error('[admin-sse] token mint failed:', (e as Error).message)
    return NextResponse.json({ error: 'Upstream credential unavailable.' }, { status: 502 })
  }

  // The browser-side EventSource will abort the upstream fetch when the
  // user navigates away by tearing down the response stream, so we just
  // mirror the body without extra plumbing.
  const upstream = await fetch(target, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  })

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}) as unknown as (req: NextRequest) => Promise<NextResponse>
