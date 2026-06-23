import { Injectable, Logger } from '@nestjs/common';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SearchService } from '../search/search.service';
import { EntitiesService } from '../entities/entities.service';
import { IngestService } from '../ingest/ingest.service';
import { FactsService } from '../facts/facts.service';
import { MultiHopService } from '../multi-hop/multi-hop.service';
import { SynthesizeService } from '../synthesize/synthesize.service';
import { MemoryDiffService } from '../diff/memory-diff.service';
import { IngestPredictionService } from '../ingest/ingest-predictor.service';
import { SummarizeEntityService } from '../summarize-entity/summarize-entity.service';
import { ProceduralMemoryService } from '../procedural/procedural-memory.service';
import { EmbedderService } from '../ai/embedder.service';
import { BrainScope } from '../auth/api-key.types';
import {
  NOOP_REPORTER,
  type ProgressEvent,
  type ProgressReporter,
} from './progress-reporter';
import { summarizeViaClientSampling } from './sampling';

/**
 * Translate an MCP request's `extra` parameter into a ProgressReporter
 * that emits notifications/progress on every stage tick. The caller
 * opts in by including `_meta.progressToken` on the request — a
 * client that doesn't ask for progress gets a NOOP_REPORTER and zero
 * extra round-trips.
 */
function buildProgressReporter(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: unknown) => Promise<void>;
}): ProgressReporter {
  const token = extra._meta?.progressToken;
  if (token === undefined || token === null) return NOOP_REPORTER;
  let counter = 0;
  return (event: ProgressEvent) => {
    counter += 1;
    // Fire and forget — we don't want a slow client to back-pressure
    // the tool execution.
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: event.index ?? counter,
          total: event.total,
          message: event.message
            ? `[${event.stage}] ${event.message}`
            : event.stage,
        },
      })
      .catch(() => undefined);
  };
}

const MCP_SERVER_VERSION = '0.3.0';

const HEALTH_TOOLS = [
  'search_knowledge',
  'search_multi_hop',
  'synthesize',
  'memory_diff',
  'get_entity_profile',
  'get_entity_timeline',
  'summarize_entity',
  'get_competing_facts',
  'detect_contradiction',
  'find_related_entities',
  'match_procedure',
  'list_procedures',
];

/**
 * Builds an MCP server instance bound to a single tenant + scope set.
 *
 * One McpServer per request — Streamable HTTP is request-scoped in stateless
 * mode, which suits multi-tenant per-request handling. We don't reuse server
 * instances across companies; that would require careful per-call swizzling
 * of the companyId, and the cost of constructing one is small relative to
 * the database round-trips inside each tool call.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  // This is the DI seam for every MCP-exposed surface; one
  // collaborator per tool family. Wrapping in a deps object would push
  // Nest's @Inject indirection into every call site without any
  // readability win — the constructor IS the manifest.
  /* eslint-disable-next-line max-params */
  constructor(
    private readonly search: SearchService,
    private readonly entities: EntitiesService,
    private readonly ingest: IngestService,
    private readonly facts: FactsService,
    private readonly multiHop: MultiHopService,
    private readonly synth: SynthesizeService,
    private readonly memoryDiff: MemoryDiffService,
    private readonly predictor: IngestPredictionService,
    private readonly summarizer: SummarizeEntityService,
    private readonly procedural: ProceduralMemoryService,
    private readonly embedder: EmbedderService,
  ) {}

  /**
   * Unauthenticated health probe payload — surfaces version + the
   * read-baseline tool list so setup scripts can confirm the MCP
   * endpoint is reachable BEFORE the operator pastes the API key.
   * Write- and admin-scoped tools are NOT listed; callers verify those
   * exist by hitting the authenticated endpoint with the right scope.
   */
  health(): { ok: boolean; version: string; tools: string[]; embedder: string } {
    return {
      ok: true,
      version: MCP_SERVER_VERSION,
      tools: HEALTH_TOOLS,
      embedder: this.embedderDescription(),
    };
  }

  /**
   * Short human-readable embedding-model hint surfaced in MCP tool
   * descriptions + the health probe. The reverse — picking which
   * embedder a tenant uses based on the description string — is NOT
   * supported; this is purely informational.
   */
  private embedderDescription(): string {
    try {
      const stats = this.embedder.cacheStats();
      return `${stats.provider} (${this.embedder.getDimensions()}d)`;
    } catch {
      return 'unknown';
    }
  }

  buildServer(companyId: string, scopes: BrainScope[]): McpServer {
    const server = new McpServer({
      name: 'inite-brain-service',
      version: '0.1.0',
    });
    // Read surface is split across two helpers — buildServer hits
    // eslint's max-lines-per-function (200) otherwise. Group A is the
    // query-shaped tools (search_knowledge / search_multi_hop /
    // synthesize); group B is the entity-shaped ones (profile /
    // timeline / competing / related).
    this.registerSearchTools(server, companyId, scopes);
    this.registerEntityReadTools(server, companyId, scopes);
    this.registerProceduralReadTools(server, companyId);
    this.registerReadResources(server, companyId, scopes);
    if (scopes.includes('brain:write')) {
      this.registerWriteTools(server, companyId);
    }
    if (scopes.includes('brain:admin')) {
      this.registerAdminTools(server, companyId);
    }
    return server;
  }

  /**
   * Resources are the MCP-native "read-once" surface alongside tools.
   * Clients can list and read URIs without going through a tool call —
   * an LLM can drop a resource ref straight into context. Brain
   * exposes:
   *
   *   - brain://entity/<entityId>           — full profile
   *   - brain://entity/<entityId>/timeline  — chronological audit
   *
   * Resources here are read-only. MCP's subscribe semantics would
   * require server-side per-client session state; brain runs in
   * stateless Streamable HTTP mode, so subscribe is a no-op for v1.
   * Streaming via a server-pushed changefeed resource is the v2 lift.
   */
  private registerReadResources(
    server: McpServer,
    companyId: string,
    scopes: BrainScope[],
  ): void {
    server.registerResource(
      'entity-profile',
      new ResourceTemplate('brain://entity/{entityId}', { list: undefined }),
      {
        title: 'Brain entity profile',
        description:
          'Full profile of one entity — canonical name, type, externalRefs, and active facts. Drop a brain://entity/<id> URI into a chat context to load it.',
        mimeType: 'application/json',
      },
      async (uri, params) => {
        const entityIdRaw = String(params.entityId);
        const profile = await this.entities.getProfile(
          companyId,
          entityIdRaw,
          undefined,
          scopes,
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(profile, null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      'entity-timeline',
      new ResourceTemplate('brain://entity/{entityId}/timeline', {
        list: undefined,
      }),
      {
        title: 'Brain entity timeline',
        description:
          'Chronological audit of every fact recorded against this entity, including retracted/superseded rows. Use as a drop-in context payload for "what is the full history" questions.',
        mimeType: 'application/json',
      },
      async (uri, params) => {
        const entityIdRaw = String(params.entityId);
        const timeline = await this.entities.getTimeline(
          companyId,
          entityIdRaw,
          undefined,
          undefined,
          scopes,
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(timeline, null, 2),
            },
          ],
        };
      },
    );
  }


  private registerSearchTools(
    server: McpServer,
    companyId: string,
    scopes: BrainScope[],
  ): void {
    const embedderHint = ` Embedding model on this tenant: ${this.embedderDescription()}.`;

    // ── search_knowledge ──────────────────────────────────────────────
    server.registerTool(
      'search_knowledge',
      {
        title: 'Search company knowledge',
        description:
          'Semantic search over the company knowledge graph. Returns entities with their top facts and external references back to the originating verticals. Apply asOf for historical "what did we know on X" queries.' +
          embedderHint,
        inputSchema: {
          query: z.string().describe('Natural-language query'),
          limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
          predicates: z.array(z.string()).optional().describe('Filter to these predicates only'),
          asOf: z.string().datetime().optional().describe('Knowledge as-of this ISO 8601 moment'),
          minConfidence: z.number().min(0).max(1).optional(),
        },
      },
      async (args) => {
        const out = await this.search.search(
          companyId,
          {
            query: args.query,
            limit: args.limit,
            predicates: args.predicates,
            asOf: args.asOf,
            minConfidence: args.minConfidence,
          },
          scopes,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── search_multi_hop ──────────────────────────────────────────────
    server.registerTool(
      'search_multi_hop',
      {
        title: 'Multi-hop search across the knowledge graph',
        description:
          'Planner-LLM decomposes the query into ≤ maxHops anchored sub-queries; later hops are anchored to the running entity set so the engine never spends compute on candidates already disqualified. Use for questions that combine evidence across turns / sessions, or that require reasoning over multiple entities ("tenants who complained in April AND upgraded after"). Set synthesize=true to get a grounded answer with citations alongside the per-hop trace. Returns finalEntityIds + supportingFactIds (HotpotQA-style evidence chain) so the caller can audit which facts drove the answer.' +
          embedderHint,
        inputSchema: {
          query: z.string().describe('Natural-language query'),
          maxHops: z.number().int().min(1).max(5).optional().describe(
            'Hard cap on planner hops (default 3, capped at 5 — beyond that latency dominates)',
          ),
          synthesize: z.boolean().optional().describe(
            'Run the synthesizer over the final entity set and return a grounded answer with citations',
          ),
          synthesisGuardrails: z
            .enum(['strict', 'lenient', 'off'])
            .optional()
            .describe(
              'Override guardrails when synthesize=true: strict closes to null on partial; lenient returns the answer with the verifier verdict; off skips the verifier',
            ),
          asOf: z
            .string()
            .datetime()
            .optional()
            .describe('Knowledge as-of this ISO 8601 moment'),
          predicates: z
            .array(z.string())
            .optional()
            .describe('Filter to these predicates only'),
          limit: z.number().int().min(1).max(50).optional(),
        },
      },
      async (args, extra) => {
        const reporter = buildProgressReporter(extra as never);
        const out = await this.multiHop.run(
          companyId,
          {
            query: args.query,
            maxHops: args.maxHops,
            synthesize: args.synthesize,
            synthesisGuardrails: args.synthesisGuardrails,
            asOf: args.asOf,
            predicates: args.predicates,
            limit: args.limit,
          },
          scopes,
          reporter,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── synthesize ────────────────────────────────────────────────────
    server.registerTool(
      'synthesize',
      {
        title: 'Synthesize a grounded answer from retrieved facts',
        description:
          'Runs hybrid search then feeds the retrieved facts to a generator LLM that produces a citation-bearing answer (each claim ends with [factId]); a verifier LLM then judges whether every claim is supported. Three guardrail modes: strict (default) returns null on partial / unsupported / verifier outage (fail-closed); lenient returns the answer alongside the verifier verdict; off skips the verifier. Use when you need a direct natural-language answer rather than raw search results.' +
          embedderHint,
        inputSchema: {
          query: z.string().describe('Natural-language question'),
          limit: z.number().int().min(1).max(50).optional().describe(
            'Top-K facts fed to the generator (default 10)',
          ),
          predicates: z.array(z.string()).optional(),
          asOf: z.string().datetime().optional(),
          minConfidence: z.number().min(0).max(1).optional(),
          synthesisGuardrails: z
            .enum(['strict', 'lenient', 'off'])
            .optional()
            .describe('Guardrail mode (default = SYNTHESIZE_DEFAULT_GUARDRAILS env)'),
        },
      },
      async (args, extra) => {
        const reporter = buildProgressReporter(extra as never);
        const out = await this.synth.synthesize(
          companyId,
          {
            query: args.query,
            limit: args.limit,
            predicates: args.predicates,
            asOf: args.asOf,
            minConfidence: args.minConfidence,
            synthesisGuardrails: args.synthesisGuardrails,
          },
          scopes,
          reporter,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── memory_diff ───────────────────────────────────────────────────
    server.registerTool(
      'memory_diff',
      {
        title: 'Diff brain memory between two points in time',
        description:
          'Returns everything brain learned, unlearned, or replaced between two ISO 8601 cursors [from, to). createdFacts = new active facts; retractedFacts = facts marked retracted in-window with no successor; changedFacts = facts that were superseded by another (carries before+after); newEntities = entities created in-window; forgottenEntities = GDPR-erased tombstones. Driving use case: "what changed since the last conversation?" Scope with entityIds and/or predicates to narrow the diff to a feature surface. Window is half-open; consecutive diffs over adjacent windows never double-count.',
        inputSchema: {
          from: z.string().datetime().describe('Inclusive lower bound (ISO 8601)'),
          to: z.string().datetime().describe('Exclusive upper bound (ISO 8601)'),
          entityIds: z
            .array(z.string())
            .optional()
            .describe('Scope to these entities (short or full ids)'),
          predicates: z
            .array(z.string())
            .optional()
            .describe('Scope to these predicates'),
        },
      },
      async (args) => {
        const out = await this.memoryDiff.diff(companyId, {
          from: args.from,
          to: args.to,
          entityIds: args.entityIds,
          predicates: args.predicates,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );
  }

  private registerEntityReadTools(
    server: McpServer,
    companyId: string,
    scopes: BrainScope[],
  ): void {
    // ── get_entity_profile ────────────────────────────────────────────
    server.registerTool(
      'get_entity_profile',
      {
        title: 'Get entity profile',
        description:
          'Full profile of one entity: canonical name, type, externalRefs (cross-vertical ids), and active facts. Use externalRefs to rehydrate fresh state from the originating vertical via @inite/api-kit.',
        inputSchema: {
          entityId: z.string().describe('Brain entity id (knowledge_entity:...) or short id'),
          asOf: z.string().datetime().optional(),
        },
      },
      async (args) => {
        const out = await this.entities.getProfile(companyId, args.entityId, args.asOf, scopes);
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── get_entity_timeline ───────────────────────────────────────────
    server.registerTool(
      'get_entity_timeline',
      {
        title: 'Get entity timeline',
        description:
          'Chronological audit of all facts brain has learned about this entity, including retracted ones. Useful for "what did we know when" investigations.',
        inputSchema: {
          entityId: z.string(),
          since: z.string().datetime().optional(),
          until: z.string().datetime().optional(),
        },
      },
      async (args) => {
        const out = await this.entities.getTimeline(
          companyId,
          args.entityId,
          args.since,
          args.until,
          scopes,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── summarize_entity ──────────────────────────────────────────────
    server.registerTool(
      'summarize_entity',
      {
        title: 'One-line briefing for an entity',
        description:
          "Returns a short one-line briefing about the entity — name, type, the most-confident active facts, external refs — suitable for dropping into an LLM context window. Caches in-process (per companyId / entityId / asOf / styleHint) so a hot entity touched across many turns doesn't reload the profile. styleHint='neutral' | 'sales' | 'support' are template-rendered (no LLM call). styleHint='client_llm' opts into MCP SAMPLING: brain asks the connected client (Claude Desktop / agent runtime) to write the one-liner with its own model — zero brain-side OpenAI cost, perfect for self-hosters who don't want brain holding an LLM key. Falls back to neutral template + sampledBy='local_template' when the client doesn't advertise sampling capability. Use INSTEAD of profile+timeline+competing when you only need a briefing.",
        inputSchema: {
          entityId: z
            .string()
            .describe('Brain entity id (knowledge_entity:...) or short id'),
          asOf: z
            .string()
            .datetime()
            .optional()
            .describe('Summarize what was known at this ISO 8601 moment'),
          styleHint: z
            .enum(['neutral', 'sales', 'support', 'client_llm'])
            .optional()
            .describe(
              "Phrasing register — 'neutral' (default), 'sales', 'support', or 'client_llm' (delegate to client-side LLM via MCP sampling; falls back to neutral template if client doesn't support sampling)",
            ),
        },
      },
      async (args) => {
        if (args.styleHint === 'client_llm') {
          const out = await summarizeViaClientSampling(
            { entities: this.entities, summarizer: this.summarizer },
            server,
            companyId,
            args.entityId,
            args.asOf,
            scopes,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out as any,
          };
        }
        const out = await this.summarizer.summarize(
          companyId,
          {
            entityId: args.entityId,
            asOf: args.asOf,
            styleHint: args.styleHint,
          },
          scopes,
        );
        return {
          content: [
            { type: 'text', text: JSON.stringify(out, null, 2) },
          ],
          structuredContent: { ...out, sampledBy: 'local_template' } as any,
        };
      },
    );

    // ── get_competing_facts ───────────────────────────────────────────
    server.registerTool(
      'get_competing_facts',
      {
        title: 'List competing facts for an entity',
        description:
          "Returns facts in COMPETING status — those the conflict resolver couldn't auto-supersede because two same-predicate bitemporal facts overlap in valid-time and are too cosine-close within margin. Grouped by (entityId, predicate); 2-fact groups are pairs the resolver left for adjudication, 3+-fact groups are multi-way disagreements escalated for human review. Use as preflight before record_fact (\"is this entity already conflicted on this predicate?\") or to drive an in-product reviewer queue. asOf filters to disagreements that were live at that moment.",
        inputSchema: {
          entityId: z
            .string()
            .describe('Brain entity id (knowledge_entity:...) or short id'),
          predicate: z
            .string()
            .optional()
            .describe('Filter to one predicate (e.g. "status", "address")'),
          asOf: z
            .string()
            .datetime()
            .optional()
            .describe('Show what was competing at this ISO 8601 moment'),
        },
      },
      async (args) => {
        const out = await this.facts.listCompeting(companyId, args.entityId, {
          predicate: args.predicate,
          asOf: args.asOf,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── detect_contradiction ──────────────────────────────────────────
    server.registerTool(
      'detect_contradiction',
      {
        title: 'Predict the conflict-resolver outcome for a candidate fact',
        description:
          "Dry-run preflight against fn::resolve_fact. Answers \"if I were to record this fact right now, what would the resolver decide?\" without writing to the database. wouldOutcome ∈ {INSERTED, SUPERSEDED, COMPETING, REJECTED}; reasoning explains which rule fired (semantics class, score gap vs margin, cosine threshold, etc); opposingFacts lists the same-predicate priors the resolver would have weighed against. Use before record_fact when the cost of a contested write is high (e.g. agent loops that pay an ingest credit). Fidelity: source_trust uses the seed table, not the learned per-tenant rate from migration 0022 — predictions can differ from the live resolver when an operator has tuned source_trust against extraction quality.",
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
          sourceVertical: z
            .string()
            .describe('Vertical attributed as source (matches record_fact)'),
        },
      },
      async (args) => {
        const out = await this.predictor.predict(companyId, {
          entityRef: args.entityRef as any,
          predicate: args.predicate,
          object: args.object,
          validFrom: args.validFrom,
          validUntil: args.validUntil,
          confidence: args.confidence,
          source: { vertical: args.sourceVertical },
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );

    // ── find_related_entities ─────────────────────────────────────────
    server.registerTool(
      'find_related_entities',
      {
        title: 'Find related entities',
        description: 'Get entities connected to the given one via the knowledge graph.',
        inputSchema: {
          entityId: z.string(),
          kind: z.string().optional().describe('Edge kind filter (e.g. "paid_for", "mentioned_in")'),
        },
      },
      async (args) => {
        // Pass scopes — without them getConnections signs in with an
        // empty scope set, bypassing the DB-level PII fence (every other
        // MCP tool forwards scopes).
        const out = await this.entities.getConnections(
          companyId,
          args.entityId,
          args.kind,
          scopes,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out as any,
        };
      },
    );
  }

  private registerProceduralReadTools(
    server: McpServer,
    companyId: string,
  ): void {
    // ── match_procedure ───────────────────────────────────────────────
    server.registerTool(
      'match_procedure',
      {
        title: 'Match procedural memory against a context query',
        description:
          "Cosine-matches procedural memory (curated 'how to' patterns the operator recorded) against a free-text context query. Returns top-K procedures sorted by similarity DESC then priority ASC. Use at the top of an agent loop to surface behaviour rules that should apply — e.g. \"user asks about pricing\" → \"mention they're on platinum tier; they get 20% off\". Procedural memory is the third tier alongside facts (semantic) and episodes (timeline).",
        inputSchema: {
          query: z.string().describe('Natural-language context'),
          limit: z.number().int().min(1).max(20).optional(),
          minSimilarity: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('Floor (default 0.4); rows below are dropped'),
        },
      },
      async (args) => {
        const out = await this.procedural.match(companyId, {
          query: args.query,
          limit: args.limit,
          minSimilarity: args.minSimilarity,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: { matches: out } as any,
        };
      },
    );

    // ── list_procedures ───────────────────────────────────────────────
    server.registerTool(
      'list_procedures',
      {
        title: 'List recorded procedural memory entries',
        description:
          'Paginated listing of procedural memory for admin/review UIs. Sorted by priority ASC, createdAt DESC. Set includeRetired=true to see soft-deleted rows.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional(),
          includeRetired: z.boolean().optional(),
        },
      },
      async (args) => {
        const out = await this.procedural.list(companyId, {
          limit: args.limit,
          includeRetired: args.includeRetired,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: { procedures: out } as any,
        };
      },
    );
  }


  private registerWriteTools(server: McpServer, companyId: string): void {
    {
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
          const out = await this.ingest.ingestFact(companyId, {
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
          const out = await this.ingest.ingestLink(companyId, {
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
          const out = await this.facts.retract(companyId, args.factId, {
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
          const out = await this.procedural.record(companyId, {
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
          const out = await this.procedural.retire(companyId, args.procedureId);
          return {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            structuredContent: out as any,
          };
        },
      );
    }
  }

  // ── forget_entity ───────────────────────────────────────────────
  // GDPR-grade destructive operation — gated on brain:admin to keep
  // it well away from any agent loop with brain:write. The HTTP path
  // requires brain:admin for the same reason.
  private registerAdminTools(server: McpServer, companyId: string): void {
    {
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
          const out = await this.entities.forget(companyId, args.entityId, {
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
  }
}
