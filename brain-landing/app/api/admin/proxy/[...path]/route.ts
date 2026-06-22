import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/server-auth'
import { brainFetch } from '@/lib/brain-api'
import { LeasesResponseSchema } from '@/lib/contracts/admin-leases'
import { SchedulerResponseSchema } from '@/lib/contracts/admin-scheduler'
import { ChangefeedStateResponseSchema } from '@/lib/contracts/admin-changefeed-state'
import { JobsListResponseSchema } from '@/lib/contracts/admin-jobs'
import { OverviewResponseSchema } from '@/lib/contracts/admin-overview'
import { AuditPageResponseSchema } from '@/lib/contracts/admin-audit-page'
import { DlqResponseSchema } from '@/lib/contracts/admin-dlq'
import { ForgottenResponseSchema } from '@/lib/contracts/admin-forgotten'
import { OperatorActionsResponseSchema } from '@/lib/contracts/admin-operator-actions'
import { MigrationsResponseSchema } from '@/lib/contracts/admin-migrations'
import { ThrottlerResponseSchema } from '@/lib/contracts/admin-throttler'
import { NowResponseSchema } from '@/lib/contracts/admin-now'
import { HealthComponentsResponseSchema } from '@/lib/contracts/admin-health-components'
import { PiiInventoryResponseSchema } from '@/lib/contracts/admin-pii'
import { ConfigResponseSchema } from '@/lib/contracts/admin-config'
import { CostResponseSchema } from '@/lib/contracts/admin-cost'
import { CalibrationResponseSchema } from '@/lib/contracts/admin-calibration'
import { RouterStatsResponseSchema } from '@/lib/contracts/admin-router-stats'
import { PredicatesListResponseSchema } from '@/lib/contracts/admin-predicates'
import { ScenariosResponseSchema } from '@/lib/contracts/admin-scenarios'
import { BaselinesResponseSchema } from '@/lib/contracts/admin-baselines'
import { TracesResponseSchema } from '@/lib/contracts/admin-traces'
import { DreamsSummaryResponseSchema } from '@/lib/contracts/admin-dreams-summary'
import { DreamsEmitsResponseSchema } from '@/lib/contracts/admin-dreams-emits'
import { TraceDetailResponseSchema } from '@/lib/contracts/admin-trace-detail'
import { ScenarioDetailResponseSchema } from '@/lib/contracts/admin-scenario-detail'
import { JobRowSchema } from '@/lib/contracts/admin-jobs'
import type { ZodType } from 'zod'

/**
 * Boundary parse for endpoints we have wire contracts for. Match by
 * exact subpath. If the upstream payload no longer satisfies the
 * schema, we 502 with the issue list — that's the whole point of G2:
 * silent drift becomes a loud failure visible to the operator instead
 * of a stale field on a panel nobody notices.
 *
 * The map is intentionally tiny — adding a new endpoint requires
 * shipping a schema first.
 */
const RESPONSE_SCHEMAS: Record<string, ZodType> = {
  'v1/admin/leases': LeasesResponseSchema,
  'v1/admin/scheduler': SchedulerResponseSchema,
  'v1/admin/changefeed/state': ChangefeedStateResponseSchema,
  'v1/admin/jobs': JobsListResponseSchema,
  'v1/admin/overview': OverviewResponseSchema,
  'v1/admin/audit': AuditPageResponseSchema,
  'v1/admin/dlq': DlqResponseSchema,
  'v1/admin/forgotten': ForgottenResponseSchema,
  'v1/admin/operator-actions': OperatorActionsResponseSchema,
  'v1/admin/migrations': MigrationsResponseSchema,
  'v1/admin/throttler': ThrottlerResponseSchema,
  'v1/admin/now': NowResponseSchema,
  'v1/admin/health/components': HealthComponentsResponseSchema,
  'v1/admin/pii': PiiInventoryResponseSchema,
  'v1/admin/config': ConfigResponseSchema,
  'v1/admin/cost': CostResponseSchema,
  'v1/admin/calibration': CalibrationResponseSchema,
  'v1/admin/router/stats': RouterStatsResponseSchema,
  'v1/admin/predicates': PredicatesListResponseSchema,
  'v1/admin/scenarios': ScenariosResponseSchema,
  'v1/admin/baselines': BaselinesResponseSchema,
  'v1/admin/traces': TracesResponseSchema,
  'v1/admin/dreams/summary': DreamsSummaryResponseSchema,
}

/**
 * Dynamic-path response schemas — paths with :params (e.g.
 * /jobs/:runId). Patterns are matched against subpath in order;
 * first match wins. Each pattern uses `:placeholder` syntax that
 * expands to a single non-slash segment. Express-style; deliberately
 * simple — no wildcard or regex inside placeholders.
 */
const DYNAMIC_RESPONSE_SCHEMAS: Array<{
  pattern: string
  schema: ZodType
}> = [
  { pattern: 'v1/admin/jobs/:runId', schema: JobRowSchema },
  { pattern: 'v1/admin/scenarios/:id', schema: ScenarioDetailResponseSchema },
  { pattern: 'v1/admin/traces/:requestId', schema: TraceDetailResponseSchema },
  {
    pattern: 'v1/admin/dreams/runs/:runId/emits',
    schema: DreamsEmitsResponseSchema,
  },
]

function placeholderToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) =>
      seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${escaped}$`)
}

const DYNAMIC_SCHEMAS_COMPILED = DYNAMIC_RESPONSE_SCHEMAS.map((entry) => ({
  re: placeholderToRegex(entry.pattern),
  schema: entry.schema,
}))

function findSchema(subpath: string): ZodType | undefined {
  const exact = RESPONSE_SCHEMAS[subpath]
  if (exact) return exact
  for (const { re, schema } of DYNAMIC_SCHEMAS_COMPILED) {
    if (re.test(subpath)) return schema
  }
  return undefined
}

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
  'v1/admin/audit',
  'v1/admin/dreams/run',
  'v1/admin/scenarios',
  'v1/admin/baselines',
  'v1/admin/traces',
  'v1/admin/tenants/',
  'v1/admin/demo/',
  'v1/admin/predicates',
  'v1/admin/router/stats',
  'v1/admin/reindex/',
  'v1/admin/calibration',
  'v1/admin/cost',
  'v1/admin/jobs',
  'v1/admin/scheduler',
  'v1/admin/changefeed',
  'v1/admin/maintenance/',
  'v1/admin/dreams',
  'v1/admin/config',
  'v1/admin/dlq',
  'v1/admin/forgotten',
  'v1/admin/pii',
  'v1/admin/operator-actions',
  'v1/admin/health/components',
  'v1/admin/migrations',
  'v1/admin/throttler',
  'v1/admin/now',
  // Brain user-facing endpoints used by the Playground tabs
  'v1/search',
  'v1/synthesize',
  'v1/entities/',
  'v1/ingest/mention',
  'v1/ingest/fact',
  'v1/ingest/link',
  'v1/facts/',
  // Read-aware ops
  'v1/dreams/run',
  'v1/search/multi-hop',
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

  // When the caller appends ?debug=1, forward X-Brain-Debug:1 so the
  // backend writes a per-request span buffer + returns __trace in the
  // response body. Strip the marker from the upstream query so brain
  // doesn't see it.
  const debug = query.debug === '1'
  if (debug) delete query.debug

  const res = await brainFetch(`/${subpath}`, {
    method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    body,
    query,
    headers: debug ? { 'X-Brain-Debug': '1' } : undefined,
  })

  const schema =
    request.method === 'GET' && res.ok ? findSchema(subpath) : undefined
  if (schema) {
    const parsed = schema.safeParse(res.data)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `wire-contract violation for /${subpath}`,
          issues: parsed.error.issues,
        },
        { status: 502 },
      )
    }
    return NextResponse.json(parsed.data, { status: 200 })
  }

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
