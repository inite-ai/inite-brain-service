import { SITE_URL, ORG, PARENT } from '../../../lib/seo'
import { ACTIONS } from '../agent-actions/route'

export const dynamic = 'force-static'

/**
 * GET /.well-known/agent-card.json — Brain's A2A Agent Card.
 *
 * A2A reached v1.0 under the Linux Foundation in 2026 and this is the path
 * RFC 8615 reserves for it. Brain already published `/.well-known/
 * agent-actions`, which is INITE's own convention and read by nothing outside
 * this company; this is the one another vendor's agent will look for.
 *
 * The skills are derived from the same `ACTIONS` array the manifest serves,
 * not retyped. Two lists of the same nine operations would disagree the first
 * time one of them changed, and the audit that found this file missing is the
 * same audit that would then report the wrong capabilities.
 *
 * ── One interface, and why not two ────────────────────────────────────────
 *
 * Brain speaks REST and MCP. Only MCP is declared. `HTTP+JSON` is one of
 * A2A's core protocol bindings and means A2A carried over HTTP with JSON
 * bodies — not "this service has a REST API". Declaring it would tell a
 * client it can speak A2A here, which it cannot. The REST surface is
 * described by OpenAPI at /openapi.json and by the agent-actions manifest,
 * both of which say what they are.
 *
 * `protocolBinding` is defined by the specification as an open-form string,
 * so `MCP` is conformant and true.
 *
 * The URL carries `{companyId}` because Brain is multi-tenant and the
 * endpoint genuinely is per-tenant. A card that named a single URL would be
 * naming one that works for nobody.
 *
 * Unsigned: v1.0 signatures are optional and signing means a private key in
 * the build. That is a decision to take rather than one to assume.
 */

/** Ingest and deletion mutate; everything else reads. Tags follow that split. */
function tagsFor(action: { id: string; mutation?: boolean }): string[] {
  const base = ['knowledge-graph', 'memory']
  if (action.mutation) return [...base, 'write']
  return [...base, 'retrieval']
}

export function GET() {
  const card = {
    protocolVersion: '1.0',
    name: ORG.name,
    description: ORG.description,

    supportedInterfaces: [
      { url: `${SITE_URL}/mcp/{companyId}`, protocolBinding: 'MCP', protocolVersion: '1.0' },
    ],

    version: '1.0.0',
    documentationUrl: `${SITE_URL}/en/docs`,
    iconUrl: ORG.logo,

    provider: {
      organization: PARENT.legalName,
      url: PARENT.url,
    },

    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },

    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],

    skills: ACTIONS.map((action) => ({
      id: action.id,
      name: action.id
        .split('-')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' '),
      description: action.description,
      tags: tagsFor(action),
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),

    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Per-tenant API key in the Authorization header. The MCP endpoint at ' +
          '/mcp/{companyId} exposes the same tools, typed.',
      },
    },
    securityRequirements: [{ apiKey: [] }],
  }

  return new Response(JSON.stringify(card, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
