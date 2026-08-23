import { BadRequestException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { envFlagEnabled } from '../common/env-validation';
import type { IngestService } from '../ingest/ingest.service';
import type { FactsService } from '../facts/facts.service';
import type { ProceduralMemoryService } from '../procedural/procedural-memory.service';
import type { EntitiesService } from '../entities/entities.service';
import type { DocumentIngestService } from '../documents/document-ingest.service';
import type { FeedbackService } from '../feedback/feedback.service';
import { DOC_TEXT_HARD_CAP } from '../documents/dto/ingest-document.dto';
import { docMaxChars } from '../documents/documents-gate';
import type { BrainScope } from '../auth/api-key.types';
import type { MetricsService } from '../metrics/metrics.service';
import { asStructuredContent } from './structured';

export interface WriteToolDeps {
  ingest: IngestService;
  facts: FactsService;
  procedural: ProceduralMemoryService;
  documents?: DocumentIngestService;
  feedback?: FeedbackService;
  /** G9 write-anomaly counter — record_fact fires the `mcp` origin path. */
  metrics?: MetricsService | undefined;
}

export interface AdminToolDeps {
  entities: EntitiesService;
  /**
   * Caller key hash — stamped as forgottenBy on the GDPR proof-of-erasure
   * tombstone. Without it every MCP-initiated Art. 17 erasure was recorded
   * as forgottenBy='unknown' while the REST path recorded the actor.
   */
  actorKeyHash: string;
}

/**
 * Registers the brain:write mutation surface — record_fact, link_entities,
 * retract_fact, record_procedure, retire_procedure — on an MCP server
 * bound to one tenant. buildServer only calls this when the caller holds
 * brain:write. Same `server.registerTool` pattern as community-tools.ts.
 */
export function registerWriteTools({
  server,
  companyId,
  deps,
  scopes,
  actorKeyHash,
  actorId,
}: {
  server: McpServer;
  companyId: string;
  deps: WriteToolDeps;
  scopes: BrainScope[];
  /** Caller key hash — actor identity for record_feedback's one-vote fence. */
  actorKeyHash?: string | undefined;
  /** Acting client (agent) identity — stamped into fact provenance. */
  actorId?: string | undefined;
}): void {
  // The recorder names WHICH agent wrote the fact (token act/client_id),
  // not just that "an MCP agent" did — feeds per-agent trust and audits.
  const recorder = actorId ? `mcp_agent:${actorId}` : 'mcp_agent';
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
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: the fact (and, for a vertical+id entityRef, the entity) belongs to this end-user only — invisible to other users and to requests that don't assert the same userId",
          ),
      },
    },
    async (args) => {
      // G9 write-anomaly signal: the `mcp` origin overlay (the direct-
      // write abuse surface). The underlying ingestFact also fires the
      // `fact` path — query per-path, don't sum labels.
      deps.metrics?.countIngestWrite('mcp');
      const out = await deps.ingest.ingestFact(companyId, {
        entityRef: args.entityRef,
        predicate: args.predicate,
        object: args.object,
        validFrom: args.validFrom,
        ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        source: { vertical: args.sourceVertical, recorder },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  // ── ingest_document ────────────────────────────────────────────
  // Registered only when the documents pipeline is wired AND enabled —
  // agents shouldn't see a tool that answers 503.
  if (deps.documents && envFlagEnabled(process.env.DOCUMENT_INGEST_ENABLED)) {
    registerIngestDocumentTool({ server, companyId, documents: deps.documents, recorder });
  }

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
        from: args.from,
        to: args.to,
        kind: args.kind,
        ...(args.weight !== undefined ? { weight: args.weight } : {}),
        source: { vertical: args.sourceVertical },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
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
        retractedBy: z
          .object({
            userId: z.string().max(200).optional(),
            source: z.enum(['human', 'system']),
          })
          .optional()
          .describe(
            "Who initiated the retraction — mirrors the REST RetractFactDto. Omit for the pre-existing default ({source: 'system'}); pass {source: 'human', userId} when relaying an operator/user decision so the audit trail records the real initiator",
          ),
      },
    },
    async (args) => {
      // callerScopes gates predicate-class elevation (billing_event /
      // human_declared / legal-source need brain:admin) — same fence as
      // the HTTP path in facts.controller.ts. Omitting it would skip
      // the check entirely (FactsService treats undefined as a legacy
      // in-process caller).
      const retractedBy = args.retractedBy
        ? {
            source: args.retractedBy.source,
            ...(args.retractedBy.userId !== undefined
              ? { userId: args.retractedBy.userId }
              : {}),
          }
        : ({ source: 'system' } as const);
      const out = await deps.facts.retract({
        companyId,
        factId: args.factId,
        dto: {
          reason: args.reason,
          retractedBy,
        },
        callerScopes: scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  registerFeedbackTool({ server, companyId, deps, actorKeyHash });

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
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.decayHalfLifeDays !== undefined
          ? { decayHalfLifeDays: args.decayHalfLifeDays }
          : {}),
        source: { kind: args.sourceKind ?? 'operator' },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
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
        structuredContent: asStructuredContent(out),
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
// Split out of registerWriteTools for the max-lines-per-function gate.
function registerFeedbackTool({
  server,
  companyId,
  deps,
  actorKeyHash,
}: {
  server: McpServer;
  companyId: string;
  deps: WriteToolDeps;
  actorKeyHash?: string | undefined;
}): void {
  if (!deps.feedback) return;
  const feedback = deps.feedback;
  server.registerTool(
    'record_feedback',
    {
      title: 'Report whether a retrieved fact was useful',
      description:
        "Close the retrieval loop: after using a fact from search_knowledge / synthesize, report 'helpful' (it answered the question), 'incorrect' (the fact is wrong — counts against its source's learned reputation at the nightly refit), or 'not_helpful' (irrelevant hit; stored, but not a reliability signal). One standing vote per caller key per fact — repeat calls replace your previous verdict.",
      inputSchema: {
        factId: z.string(),
        verdict: z.enum(['helpful', 'not_helpful', 'incorrect']),
        reason: z.string().max(1000).optional(),
      },
    },
    async (args) => {
      const out = await feedback.record({
        companyId,
        factId: args.factId,
        verdict: args.verdict,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        actor: actorKeyHash ?? `mcp:${companyId}`,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

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
      const out = await deps.entities.forget({
        companyId,
        entityIdRaw: args.entityId,
        actorKeyHash: deps.actorKeyHash,
        dto: {
          reason: args.reason,
          requestId: args.requestId,
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

/**
 * The ingest_document registration — split from registerWriteTools to
 * keep it under the function-size gate. Feeds a normalized document
 * through Source → Indexer → Candidates → Brain synchronously.
 */
function registerIngestDocumentTool({
  server,
  companyId,
  documents,
  recorder,
}: {
  server: McpServer;
  companyId: string;
  documents: DocumentIngestService;
  /** Agent-attributed recorder identity (mcp_agent[:<client_id>]). */
  recorder: string;
}): void {
  server.registerTool(
    'ingest_document',
    {
      title: 'Ingest a normalized document',
      description:
        "Feed a normalized document (meeting transcript, email body, markdown…) through the Source → Indexer → Candidates → Brain pipeline: it is stored (content-hash deduped), read by the generalist indexer, staged as candidates, and committed through conflict resolution. Pass indexers:'auto' to additionally route relevant installed domain packs (requires DOCUMENT_MULTI_INDEXER_ENABLED on the server; default 'general' runs only the generalist union pass). Prefer this over record_fact for anything longer than one claim.",
      inputSchema: {
        kind: z
          .string()
          .max(64)
          .describe('Container kind: chat | email | markdown | pdf | …'),
        text: z
          .string()
          .max(DOC_TEXT_HARD_CAP)
          .describe('Normalized document text'),
        title: z.string().max(512).optional(),
        originUri: z
          .string()
          .max(512)
          .optional()
          .describe('Pointer back to the raw container'),
        occurredAt: z
          .string()
          .datetime()
          .describe("The document's own timestamp — becomes facts' validFrom"),
        vertical: z.string().describe('Vertical attributed as source'),
        storeContent: z
          .boolean()
          .optional()
          .describe('false keeps only the content hash (no re-indexing later)'),
        indexers: z
          .enum(['general', 'auto'])
          .optional()
          .describe(
            "'general' (default) = generalist union pass only; 'auto' = also route relevant installed domain packs (server must have DOCUMENT_MULTI_INDEXER_ENABLED)",
          ),
      },
    },
    async (args) => {
      // The runtime DOC_MAX_CHARS cap (an operator may lower it below the
      // static hard cap) only lives on the REST controller; enforce it here
      // too so the MCP path can't bypass it and burn LLM budget uncapped.
      if (args.text.length > docMaxChars()) {
        // BadRequestException (not plain Error): the McpService error
        // wrapper masks unexpected errors but passes 4xx through — this
        // message is deliberately client-facing.
        throw new BadRequestException(
          `text exceeds DOC_MAX_CHARS (${docMaxChars()})`,
        );
      }
      const out = await documents.ingestDocument(companyId, {
        kind: args.kind,
        text: args.text,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.originUri !== undefined ? { originUri: args.originUri } : {}),
        occurredAt: args.occurredAt,
        contextRef: { vertical: args.vertical, recorder },
        ...(args.storeContent !== undefined
          ? { storeContent: args.storeContent }
          : {}),
        indexers: args.indexers ?? 'general',
        mode: 'sync',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}
