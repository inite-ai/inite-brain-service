import { SITE_URL, ORG, GITHUB_URL } from '../../../lib/seo'

export const dynamic = 'force-static'

/**
 * GET /.well-known/agent-actions — machine-readable manifest of Brain's
 * callable API surface. Agents that fetch this discover the endpoints,
 * their fields, auth, and side effects, and can call the API directly
 * instead of scraping. The MCP endpoint is the richer, typed path.
 */

interface AgentAction {
  id: string
  description: string
  url: string
  method: 'GET' | 'POST'
  fields?: string[]
  auth: 'api_key'
  mutation?: boolean
}

const API = 'https://brain.inite.ai'

const ACTIONS: AgentAction[] = [
  {
    id: 'search',
    description:
      'Hybrid retrieval over a tenant knowledge graph. Returns ranked entities and facts with a per-leg score breakdown. Pass asOf for a bitemporal query.',
    url: `${API}/v1/search`,
    method: 'POST',
    fields: ['query', 'limit', 'asOf'],
    auth: 'api_key',
  },
  {
    id: 'synthesize',
    description:
      'Corrective-RAG answer with a claim-level faithfulness score. Guardrail modes: strict / lenient / off.',
    url: `${API}/v1/synthesize`,
    method: 'POST',
    fields: ['query', 'guardrail'],
    auth: 'api_key',
  },
  {
    id: 'multi-hop',
    description:
      'Planner-decomposed multi-hop search. Splits a question into anchored sub-queries and returns supporting facts.',
    url: `${API}/v1/search/multi-hop`,
    method: 'POST',
    fields: ['query', 'maxHops'],
    auth: 'api_key',
  },
  {
    id: 'ingest-fact',
    description:
      'Ingest a declared structured fact (subject-predicate-object) with valid time and source. Conflict resolver decides INSERTED / COMPETING / SUPERSEDED.',
    url: `${API}/v1/ingest/fact`,
    method: 'POST',
    fields: ['entityRef', 'predicate', 'object', 'validFrom', 'source'],
    auth: 'api_key',
    mutation: true,
  },
  {
    id: 'ingest-mention',
    description: 'NLU extraction from free text into entities and facts.',
    url: `${API}/v1/ingest/mention`,
    method: 'POST',
    fields: ['text', 'source'],
    auth: 'api_key',
    mutation: true,
  },
  {
    id: 'entity-profile',
    description: 'Entity profile with active facts, PII-gated by scope.',
    url: `${API}/v1/entities/:id`,
    method: 'GET',
    auth: 'api_key',
  },
  {
    id: 'entity-timeline',
    description:
      'Bitemporal sweep of an entity — every fact ever known, with valid and transaction time.',
    url: `${API}/v1/entities/:id/timeline`,
    method: 'GET',
    auth: 'api_key',
  },
  {
    id: 'retract-fact',
    description: 'Mark a fact retracted with a reason. Stays in the audit trail.',
    url: `${API}/v1/facts/:id/retract`,
    method: 'POST',
    fields: ['reason'],
    auth: 'api_key',
    mutation: true,
  },
  {
    id: 'forget-entity',
    description:
      'GDPR hard delete — facts, edges, and embeddings removed; only an HMAC tombstone remains.',
    url: `${API}/v1/entities/:id/forget`,
    method: 'POST',
    auth: 'api_key',
    mutation: true,
  },
]

export function GET() {
  const body = {
    name: ORG.name,
    description: ORG.description,
    homepage: SITE_URL,
    documentation: `${SITE_URL}/en/docs`,
    openapi: `${API}/openapi.json`,
    repository: GITHUB_URL,
    auth: {
      type: 'api_key',
      header: 'Authorization',
      scheme: 'Bearer',
      note: 'Per-tenant API key. The MCP endpoint at /mcp/<companyId> exposes the same tools, typed.',
    },
    mcp: `${API}/mcp/<companyId>`,
    actions: ACTIONS,
  }
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
