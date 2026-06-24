import { NextRequest, NextResponse } from 'next/server'
import { withUser, type UserSession } from '@/lib/server-auth'
import { brainFetch, USER_SCOPE } from '@/lib/brain-api'
import { extractProxyPath, collectQuery, isPathAllowed } from '@/lib/bff-proxy'

/**
 * /api/app/proxy/[...path] — end-user BFF for the brain backend.
 *
 * Sibling of `/api/admin/proxy` but for the product UI under
 * `/[lang]/app/**`. Guard rails:
 *
 *   1. Tenancy fail-closed (`BRAIN_APP_ENABLED`). brain derives the
 *      tenant (companyId) from the *service* credential, not the end
 *      user (src/auth/api-key.guard.ts), so every authenticated user
 *      maps to the single company this brain-landing instance is bound
 *      to. Until per-user companyId propagation exists, the end-user
 *      surface is only safe on a single-company deployment — so it is
 *      OFF unless the operator explicitly opts in, asserting that.
 *   2. `withUser` — any authenticated OAuth user (not admin-only).
 *   3. A tight, segment-anchored allow-list of user-facing endpoints.
 *      No `v1/admin/*` path is reachable; `/forget` is denied outright.
 *   4. Writes default to admins only; open to all authenticated users
 *      only when `BRAIN_APP_ALLOW_USER_WRITES=1`.
 *   5. The M2M token is minted with USER_SCOPE (`brain:read
 *      brain:write`) — no admin, no PII. PII predicates come back
 *      redacted.
 *   6. The internal debug `__trace` is forwarded only for admins.
 */

const ROUTE_PREFIX = '/api/app/proxy/'

// Read paths every authenticated user may reach.
const READ_PREFIXES = [
  'v1/search',
  'v1/synthesize',
  'v1/entities/',
  'v1/communities',
  'v1/stats',
  'health',
]

// Write paths (still brain:write scope). Gated additionally by role —
// see canWrite() — so a read-only visitor can't mutate the company's
// memory just by being logged in.
const WRITE_PREFIXES = [
  'v1/ingest/fact',
  'v1/ingest/mention',
  'v1/ingest/link',
  'v1/facts/',
]

// Denied even though a broader allow prefix would otherwise sweep them
// in. `v1/entities/` is needed for profiles/timeline/connections but
// must never expose the admin-only GDPR erase.
const DENIED_SUFFIXES = ['/forget']

function appEnabled(): boolean {
  return process.env.BRAIN_APP_ENABLED === '1'
}

function isWritePath(subpath: string): boolean {
  return isPathAllowed(subpath, { allow: WRITE_PREFIXES })
}

function canWrite(session: UserSession): boolean {
  return session.isAdmin || process.env.BRAIN_APP_ALLOW_USER_WRITES === '1'
}

async function forward(
  session: UserSession,
  request: NextRequest,
): Promise<NextResponse> {
  if (!appEnabled()) {
    return NextResponse.json(
      {
        error:
          'end-user app is disabled on this deployment (set BRAIN_APP_ENABLED=1 for single-company instances)',
      },
      { status: 403 },
    )
  }

  const subpath = extractProxyPath(request, ROUTE_PREFIX).join('/')
  if (!isPathAllowed(subpath, { allow: READ_PREFIXES.concat(WRITE_PREFIXES), deny: DENIED_SUFFIXES })) {
    return NextResponse.json(
      { error: `path '/${subpath}' is not in the app proxy allow-list` },
      { status: 403 },
    )
  }

  const writing = request.method !== 'GET' && request.method !== 'HEAD'
  if (writing && isWritePath(subpath) && !canWrite(session)) {
    return NextResponse.json(
      { error: 'write access requires an admin or BRAIN_APP_ALLOW_USER_WRITES=1' },
      { status: 403 },
    )
  }

  const query = collectQuery(request)
  const body = writing
    ? await request.json().catch(() => undefined)
    : undefined

  // ?debug=1 → forward X-Brain-Debug:1 so the backend returns the
  // per-request __trace span buffer. The trace exposes internal
  // pipeline timings/IDs, so it is forwarded for admins only.
  const wantsDebug = query.debug === '1'
  if (wantsDebug) delete query.debug
  const forwardDebug = wantsDebug && session.isAdmin

  const res = await brainFetch(`/${subpath}`, {
    method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    body,
    query,
    scope: USER_SCOPE,
    headers: forwardDebug ? { 'X-Brain-Debug': '1' } : undefined,
  })

  return NextResponse.json(res.data ?? { error: res.error }, {
    status: res.status || (res.ok ? 200 : 502),
  })
}

export const GET = withUser(forward)
export const POST = withUser(forward)
export const PUT = withUser(forward)
export const DELETE = withUser(forward)
