import { NextRequest, NextResponse } from 'next/server'
import { withAdmin, extractAccessToken } from '@/lib/server-auth'
import { getBrainToken } from '@/lib/brain-api'

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
    // Same identity-preserving exchange as the JSON proxy (M2M fallback
    // for dev-bypass sessions).
    token = await getBrainToken({
      scope: SSE_SCOPE,
      userToken: await extractAccessToken(request),
    })
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    )
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
