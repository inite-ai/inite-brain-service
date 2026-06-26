import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IngestService } from '../ingest/ingest.service';
import type { FactsService } from '../facts/facts.service';
import type { ProceduralMemoryService } from '../procedural/procedural-memory.service';
import type { EntitiesService } from '../entities/entities.service';

export interface WriteToolDeps {
  ingest: IngestService;
  facts: FactsService;
  procedural: ProceduralMemoryService;
}

export interface AdminToolDeps {
  entities: EntitiesService;
}

/**
 * Registers the brain:write mutation surface — record_fact, link_entities,
 * retract_fact, record_procedure, retire_procedure — on an MCP server
 * bound to one tenant. buildServer only calls this when the caller holds
 * brain:write. Same `server.registerTool` pattern as community-tools.ts.
 */
export function registerWriteTools(
  server: McpServer,
  companyId: string,
  deps: WriteToolDeps,
): void {
  // ── record_fact ────────────────────────────────────────────────
  server.registerTool(
    'record_fact',
    {
      title: 'Record a fact about an entity',
      description:
        'Insert a fact about an entity. Triggers brain conflict resolution (INSERTED / SUPERSEDED / COMPETING / REJECTED). Use sparingly from agents — most facts should come from event ingestion.',
      inputSchema: {
        entityRef: z.union([
          z.object({ vertical: z.string(), id: z.string() }),
          z.object({ entityId: z.string() }),
        ]),
        predicate: z.string(),
        object: z.string(),
        validFrom: z.string().datetime(),
        validUntil: z.string().datetime().optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceVertical: z.string().describe('Vertical name attributed as source (e.g. "rent")'),
      },
    },
    async (args) => {
      const out = await deps.ingest.ingestFact(companyId, {
        entityRef: args.entityRef as any,
        predicate: args.predicate,
        object: args.object,
        validFrom: args.validFrom,
        validUntil: args.validUntil,
        confidence: args.confidence,
        source: { vertical: args.sourceVertical, recorder: 'mcp_agent' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );

  // ── link_entities ──────────────────────────────────────────────
  server.registerTool(
    'link_entities',
    {
      title: 'Declare a typed edge between two entities',
      description:
        'Insert an edge between two entities. `kind` is the edge type — `identity_of` merges the `from` entity into `to` (cross-vertical identity reconciliation), other typed edges (`paid_for`, `mentioned_in`, `worked_with`, …) are surfaced by find_related_entities and contribute to PPR / SubgraphRAG context. Use sparingly from agents — most edges come from event ingestion. identity_of rejects self-merges and contradictory cycles.',
      inputSchema: {
        from: z.union([
          z.object({ vertical: z.string(), id: z.string() }),
          z.object({ entityId: z.string() }),
        ]),
        to: z.union([
          z.object({ vertical: z.string(), id: z.string() }),
          z.object({ entityId: z.string() }),
        ]),
        kind: z.string().describe(
          'Edge type (identity_of | paid_for | mentioned_in | worked_with | …)',
        ),
        weight: z.number().min(0).max(1).optional(),
        sourceVertical: z
          .string()
          .describe('Vertical attributed as source (e.g. "rent")'),
      },
    },
    async (args) => {
      const out = await deps.ingest.ingestLink(companyId, {
        from: args.from as any,
        to: args.to as any,
        kind: args.kind,
        weight: args.weight,
        source: { vertical: args.sourceVertical },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );

  // ── retract_fact ───────────────────────────────────────────────
  server.registerTool(
    'retract_fact',
    {
      title: 'Retract a fact',
      description:
        'Mark a fact as no longer believed. Cascades to facts derived from this one. Does not delete; the row remains for audit.',
      inputSchema: {
        factId: z.string(),
        reason: z.string(),
      },
    },
    async (args) => {
      const out = await deps.facts.retract(companyId, args.factId, {
        reason: args.reason,
        retractedBy: { source: 'system' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );

  // ── record_procedure ───────────────────────────────────────────
  server.registerTool(
    'record_procedure',
    {
      title: 'Record a procedural memory (behaviour rule)',
      description:
        "Record a 'how to' pattern that match_procedure can surface when a similar context appears later. trigger = the context phrase the rule should match against (e.g. \"user asks about pricing\"); action = the behaviour to apply (e.g. \"mention they're on platinum tier; they get 20% off\"). priority orders ties when multiple procedures match the same context (lower is higher priority; default 100). decayHalfLifeDays is a forward hook for v0.2 relevance decay; v1 ignores it at read time.",
      inputSchema: {
        trigger: z.string().min(1),
        action: z.string().min(1),
        priority: z.number().int().min(0).max(1000).optional(),
        decayHalfLifeDays: z.number().int().min(1).max(3650).optional(),
        sourceKind: z
          .enum(['operator', 'agent', 'dreams_loop'])
          .optional()
          .describe('Audit tag for who recorded this — default operator'),
      },
    },
    async (args) => {
      const out = await deps.procedural.record(companyId, {
        trigger: args.trigger,
        action: args.action,
        priority: args.priority,
        decayHalfLifeDays: args.decayHalfLifeDays,
        source: { kind: args.sourceKind ?? 'operator' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );

  // ── retire_procedure ───────────────────────────────────────────
  server.registerTool(
    'retire_procedure',
    {
      title: 'Soft-retire a procedural memory entry',
      description:
        "Mark a procedural memory row as retired (sets retiredAt). Excluded from match_procedure / list_procedures by default. Use when an operator decides the rule no longer applies — distinct from a hard delete because the row stays for audit.",
      inputSchema: {
        procedureId: z
          .string()
          .describe('procedural_memory:<tail> or just the tail'),
      },
    },
    async (args) => {
      const out = await deps.procedural.retire(companyId, args.procedureId);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}

/**
 * Registers the brain:admin surface — forget_entity, a GDPR-grade
 * destructive cascade. Gated on brain:admin (buildServer only calls this
 * under that scope) to keep it well away from any agent loop carrying
 * only brain:write; the HTTP path requires brain:admin for the same
 * reason.
 */
export function registerAdminTools(
  server: McpServer,
  companyId: string,
  deps: AdminToolDeps,
): void {
  server.registerTool(
    'forget_entity',
    {
      title: 'GDPR-forget an entity (destructive, synchronous cascade)',
      description:
        'Hard delete one entity and ALL of its facts, edges, and embeddings; an HMAC-hashed tombstone stays in `forgotten_entity` for proof-of-erasure. THIS IS DESTRUCTIVE AND IRREVERSIBLE. Use only when responding to a GDPR Art. 17 right-to-erasure request or operator-grade cleanup. Reason + requestId are required for the audit trail.',
      inputSchema: {
        entityId: z
          .string()
          .describe('Brain entity id (knowledge_entity:...) or short id'),
        reason: z
          .enum(['gdpr_request', 'tenant_offboarding', 'operator_request'])
          .describe(
            'Audit-grade reason. gdpr_request for Art. 17 DSARs; tenant_offboarding for full deprovision; operator_request for one-off cleanup',
          ),
        requestId: z
          .string()
          .describe(
            'Ticket / DSAR id — surfaces in the forgotten_entity audit row. Required for traceability.',
          ),
      },
    },
    async (args) => {
      const out = await deps.entities.forget(companyId, args.entityId, {
        reason: args.reason,
        requestId: args.requestId,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}
