import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/server-auth'
import { brainFetch } from '@/lib/brain-api'

/**
 * /api/admin/proxy/[...path] — admin-gated BFF for brain backend.
 *
 * The browser never sees BRAIN_SERVICE_KEY. After the admin session
 * check passes, this route forwards the request to brain with the
 * server-side service key. Only whitelisted brain paths can be
 * proxied — a defense layer in case of a path-traversal attempt or a
 * misuse of the proxy to reach an endpoint we never intended to expose
 * via the admin UI.
 */

const ALLOWED_PREFIXES = [
  // Admin
  'v1/admin/overview',
  'v1/admin/dreams/run',
  // Read endpoints the graph explorer relies on
  'v1/search',
  'v1/entities/',
  // Read-aware ops
  'v1/dreams/run',
  // Health for the overview header
  'health',
]

function isAllowed(path: string): boolean {
  const normalized = path.replace(/^\/+/, '').replace(/\?.*$/, '')
  return ALLOWED_PREFIXES.some(
    (p) => normalized === p || normalized.startsWith(p),
  )
}

async function forward(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params
  const subpath = path.join('/')
  if (!isAllowed(subpath)) {
    return NextResponse.json(
      { error: `path '/${subpath}' is not in the admin proxy allow-list` },
      { status: 403 },
    )
  }

  const query: Record<string, string> = {}
  request.nextUrl.searchParams.forEach((v, k) => {
    query[k] = v
  })

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.json().catch(() => undefined)

  const res = await brainFetch(`/${subpath}`, {
    method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    body,
    query,
  })

  return NextResponse.json(res.data ?? { error: res.error }, {
    status: res.status || (res.ok ? 200 : 502),
  })
}

export const GET = withAdmin((_session, request) =>
  forward(request, extractCtx(request)),
)
export const POST = withAdmin((_session, request) =>
  forward(request, extractCtx(request)),
)
export const PUT = withAdmin((_session, request) =>
  forward(request, extractCtx(request)),
)
export const DELETE = withAdmin((_session, request) =>
  forward(request, extractCtx(request)),
)

// Pull dynamic [...path] segments out of the URL since `withAdmin`
// erases the second handler arg.
function extractCtx(request: NextRequest): {
  params: Promise<{ path: string[] }>
} {
  const u = request.nextUrl
  const prefix = '/api/admin/proxy/'
  const rest = u.pathname.startsWith(prefix)
    ? u.pathname.slice(prefix.length)
    : ''
  const path = rest.split('/').filter(Boolean)
  return { params: Promise.resolve({ path }) }
}
