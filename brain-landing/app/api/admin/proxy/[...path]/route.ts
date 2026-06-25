import { NextRequest, NextResponse } from 'next/server'
import { withAdmin } from '@/lib/server-auth'
import { brainFetch } from '@/lib/brain-api'
import { extractProxyPath, collectQuery, isPathAllowed } from '@/lib/bff-proxy'
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
import {
  DropTenantResponseSchema,
  DlqDeleteResponseSchema,
  PredicateDeprecateResponseSchema,
  JobCancelResponseSchema,
  AcceptedDreamsResponseSchema,
  AcceptedCompactionResponseSchema,
  AcceptedCalibrationRefitResponseSchema,
  AcceptedReindexResponseSchema,
  AcceptedScenariosBatchResponseSchema,
  ChangefeedDrainResponseSchema,
  PredicateMutationResponseSchema,
  DreamsRunResponseSchema,
  ReindexRunResponseSchema,
  ScenarioRunOutcomeSchema,
  ScenariosBatchResponseSchema,
  BaselineSaveResponseSchema,
  BaselineDiffResponseSchema,
} from '@/lib/contracts/admin-write-responses'
import type { ZodType } from 'zod'

/**
 * Boundary parse for endpoints we have wire contracts for. Match by
 * method + subpath. If the upstream payload no longer satisfies the
 * schema, we 502 with the issue list — that's the whole point of G2:
 * silent drift becomes a loud failure visible to the operator instead
 * of a stale field on a panel nobody notices.
 *
 * Maps are intentionally tight — adding a new endpoint requires
 * shipping a schema first.
 */

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const RESPONSE_SCHEMAS: Partial<
  Record<HttpMethod, Record<string, ZodType>>
> = {
  GET: {
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
  },
  POST: {
    'v1/admin/dreams/run': DreamsRunResponseSchema,
    'v1/admin/reindex/embeddings': ReindexRunResponseSchema,
    'v1/admin/maintenance/dreams/run': AcceptedDreamsResponseSchema,
    'v1/admin/maintenance/compaction': AcceptedCompactionResponseSchema,
    'v1/admin/maintenance/calibration-refit':
      AcceptedCalibrationRefitResponseSchema,
    'v1/admin/maintenance/reindex': AcceptedReindexResponseSchema,
    'v1/admin/maintenance/scenarios/batch':
      AcceptedScenariosBatchResponseSchema,
    'v1/admin/changefeed/drain': ChangefeedDrainResponseSchema,
    'v1/admin/scenarios/run-batch': ScenariosBatchResponseSchema,
    'v1/admin/predicates': PredicateMutationResponseSchema,
  },
  PATCH: {},
  DELETE: {},
}

/**
 * Dynamic-path schemas — paths with :params (e.g. /jobs/:runId).
 * Patterns use `:placeholder` syntax that expands to a single
 * non-slash segment. Express-style; deliberately simple — no
 * wildcard or regex inside placeholders.
 */
const DYNAMIC_RESPONSE_SCHEMAS: Partial<
  Record<HttpMethod, Array<{ pattern: string; schema: ZodType }>>
> = {
  GET: [
    { pattern: 'v1/admin/jobs/:runId', schema: JobRowSchema },
    { pattern: 'v1/admin/scenarios/:id', schema: ScenarioDetailResponseSchema },
    {
      pattern: 'v1/admin/traces/:requestId',
      schema: TraceDetailResponseSchema,
    },
    {
      pattern: 'v1/admin/dreams/runs/:runId/emits',
      schema: DreamsEmitsResponseSchema,
    },
  ],
  POST: [
    { pattern: 'v1/admin/jobs/:runId/cancel', schema: JobCancelResponseSchema },
    {
      pattern: 'v1/admin/scenarios/:id/run',
      schema: ScenarioRunOutcomeSchema,
    },
    { pattern: 'v1/admin/baselines/:name', schema: BaselineSaveResponseSchema },
    {
      pattern: 'v1/admin/baselines/:name/diff',
      schema: BaselineDiffResponseSchema,
    },
    {
      pattern: 'v1/admin/predicates/:predicateId/promote',
      schema: PredicateMutationResponseSchema,
    },
    {
      pattern: 'v1/admin/predicates/:predicateId/alias',
      schema: PredicateMutationResponseSchema,
    },
  ],
  PATCH: [
    {
      pattern: 'v1/admin/predicates/:predicateId',
      schema: PredicateMutationResponseSchema,
    },
  ],
  DELETE: [
    { pattern: 'v1/admin/tenants/:companyId', schema: DropTenantResponseSchema },
    { pattern: 'v1/admin/dlq/:companyId/:id', schema: DlqDeleteResponseSchema },
    {
      pattern: 'v1/admin/predicates/:predicateId',
      schema: PredicateDeprecateResponseSchema,
    },
  ],
}

function placeholderToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) =>
      seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${escaped}$`)
}

const DYNAMIC_SCHEMAS_COMPILED: Partial<
  Record<HttpMethod, Array<{ re: RegExp; schema: ZodType }>>
> = Object.fromEntries(
  (Object.entries(DYNAMIC_RESPONSE_SCHEMAS) as Array<
    [HttpMethod, Array<{ pattern: string; schema: ZodType }>]
  >).map(([method, entries]) => [
    method,
    entries.map((e) => ({ re: placeholderToRegex(e.pattern), schema: e.schema })),
  ]),
) as Partial<Record<HttpMethod, Array<{ re: RegExp; schema: ZodType }>>>

function findSchema(method: string, subpath: string): ZodType | undefined {
  const m = method.toUpperCase() as HttpMethod
  const exact = RESPONSE_SCHEMAS[m]?.[subpath]
  if (exact) return exact
  const dyn = DYNAMIC_SCHEMAS_COMPILED[m]
  if (!dyn) return undefined
  for (const { re, schema } of dyn) {
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

async function forward(
  request: NextRequest,
  path: string[],
): Promise<NextResponse> {
  const subpath = path.join('/')
  if (!isPathAllowed(subpath, { allow: ALLOWED_PREFIXES })) {
    return NextResponse.json(
      { error: `path '/${subpath}' is not in the admin proxy allow-list` },
      { status: 403 },
    )
  }

  const query = collectQuery(request)

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

  const schema = res.ok ? findSchema(request.method, subpath) : undefined
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

const ADMIN_ROUTE_PREFIX = '/api/admin/proxy/'

export const GET = withAdmin((_session, request) =>
  forward(request, extractProxyPath(request, ADMIN_ROUTE_PREFIX)),
)
export const POST = withAdmin((_session, request) =>
  forward(request, extractProxyPath(request, ADMIN_ROUTE_PREFIX)),
)
export const PUT = withAdmin((_session, request) =>
  forward(request, extractProxyPath(request, ADMIN_ROUTE_PREFIX)),
)
export const DELETE = withAdmin((_session, request) =>
  forward(request, extractProxyPath(request, ADMIN_ROUTE_PREFIX)),
)
