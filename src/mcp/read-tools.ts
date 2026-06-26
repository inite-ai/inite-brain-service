import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SearchService } from '../search/search.service';
import type { EntitiesService } from '../entities/entities.service';
import type { FactsService } from '../facts/facts.service';
import type { MultiHopService } from '../multi-hop/multi-hop.service';
import type { SynthesizeService } from '../synthesize/synthesize.service';
import type { MemoryDiffService } from '../diff/memory-diff.service';
import type { IngestPredictionService } from '../ingest/ingest-predictor.service';
import type { SummarizeEntityService } from '../summarize-entity/summarize-entity.service';
import type { BrainScope } from '../auth/api-key.types';
import {
  NOOP_REPORTER,
  type ProgressEvent,
  type ProgressReporter,
} from './progress-reporter';
import { summarizeViaClientSampling } from './sampling';

/**
 * Collaborators the read surface needs. Mirrors the constructor seam of
 * McpService — one service per tool family — so buildServer can hand them
 * straight through. `embedderDescription` is passed as a thunk so the
 * read tools can fold the live embedding-model hint into their
 * descriptions without depending on the embedder service directly.
 */
export interface ReadToolDeps {
  search: SearchService;
  entities: EntitiesService;
  facts: FactsService;
  multiHop: MultiHopService;
  synth: SynthesizeService;
  memoryDiff: MemoryDiffService;
  predictor: IngestPredictionService;
  summarizer: SummarizeEntityService;
  embedderDescription: () => string;
}

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

/**
 * Registers the brain:read surface on an MCP server bound to one tenant:
 * the query-shaped search tools, the entity-shaped read tools, and the
 * read-only resources. Split out of mcp.service.ts (same
 * `server.registerTool` pattern as community-tools.ts) to keep that file
 * under the max-lines gate and the tool families independently editable.
 */
export function registerReadTools(
  server: McpServer,
  companyId: string,
  scopes: BrainScope[],
  deps: ReadToolDeps,
): void {
  registerSearchTools(server, companyId, scopes, deps);
  registerEntityReadTools(server, companyId, scopes, deps);
  registerReadResources(server, companyId, scopes, deps);
}

function registerSearchTools(
  server: McpServer,
  companyId: string,
  scopes: BrainScope[],
  deps: ReadToolDeps,
): void {
  const embedderHint = ` Embedding model on this tenant: ${deps.embedderDescription()}.`;

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
      const out = await deps.search.search(
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
      const out = await deps.multiHop.run(
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
      const out = await deps.synth.synthesize(
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
      const out = await deps.memoryDiff.diff(companyId, {
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

function registerEntityReadTools(
  server: McpServer,
  companyId: string,
  scopes: BrainScope[],
  deps: ReadToolDeps,
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
      const out = await deps.entities.getProfile(companyId, args.entityId, args.asOf, scopes);
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
      const out = await deps.entities.getTimeline(
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
          { entities: deps.entities, summarizer: deps.summarizer },
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
      const out = await deps.summarizer.summarize(
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
      const out = await deps.facts.listCompeting(companyId, args.entityId, {
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
      const out = await deps.predictor.predict(companyId, {
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
      const out = await deps.entities.getConnections(
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

/**
 * Resources are the MCP-native "read-once" surface alongside tools.
 * Clients can list and read URIs without going through a tool call —
 * an LLM can drop a resource ref straight into context. Brain exposes:
 *
 *   - brain://entity/<entityId>           — full profile
 *   - brain://entity/<entityId>/timeline  — chronological audit
 *
 * Resources here are read-only. MCP's subscribe semantics would require
 * server-side per-client session state; brain runs in stateless
 * Streamable HTTP mode, so subscribe is a no-op for v1. Streaming via a
 * server-pushed changefeed resource is the v2 lift.
 */
function registerReadResources(
  server: McpServer,
  companyId: string,
  scopes: BrainScope[],
  deps: ReadToolDeps,
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
      const profile = await deps.entities.getProfile(
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
      const timeline = await deps.entities.getTimeline(
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
