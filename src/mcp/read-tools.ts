import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { envFlagEnabled } from '../common/env-validation';
import type { SearchService } from '../search/search.service';
import type { EntitiesService } from '../entities/entities.service';
import type { FactsService } from '../facts/facts.service';
import type { MultiHopService } from '../multi-hop/multi-hop.service';
import type { SynthesizeService } from '../synthesize/synthesize.service';
import type { MemoryDiffService } from '../diff/memory-diff.service';
import type { IngestPredictionService } from '../ingest/ingest-predictor.service';
import type { SummarizeEntityService } from '../summarize-entity/summarize-entity.service';
import type { BrainScope } from '../auth/api-key.types';
import { NOOP_REPORTER, type ProgressEvent, type ProgressReporter } from './progress-reporter';
import { summarizeViaClientSampling } from './sampling';
import { asStructuredContent } from './structured';

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
 * Args for the brain:read registration entrypoint and its per-family
 * helpers. One options object instead of the (server, companyId, scopes,
 * deps) positional quad.
 */
export interface RegisterReadToolsOptions {
  server: McpServer;
  companyId: string;
  scopes: BrainScope[];
  deps: ReadToolDeps;
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
          message: event.message ? `[${event.stage}] ${event.message}` : event.stage,
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
export function registerReadTools({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  registerSearchTools({ server, companyId, scopes, deps });
  registerEntityReadTools({ server, companyId, scopes, deps });
  registerReadResources({ server, companyId, scopes, deps });
}

function registerSearchTools({ server, companyId, scopes, deps }: RegisterReadToolsOptions): void {
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
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10)'),
        predicates: z.array(z.string()).optional().describe('Filter to these predicates only'),
        asOf: z.string().datetime().optional().describe('Knowledge as-of this ISO 8601 moment'),
        minConfidence: z.number().min(0).max(1).optional(),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: results include tenant-global facts plus this user's personal ones; omit for tenant-global only (fail-closed)",
          ),
      },
    },
    async (args) => {
      const out = await deps.search.search(
        companyId,
        {
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.predicates !== undefined ? { predicates: args.predicates } : {}),
          ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
          ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
          ...(args.userId !== undefined ? { userId: args.userId } : {}),
        },
        scopes,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
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
        maxHops: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            'Hard cap on planner hops (default 3, capped at 5 — beyond that latency dominates)',
          ),
        synthesize: z
          .boolean()
          .optional()
          .describe(
            'Run the synthesizer over the final entity set and return a grounded answer with citations',
          ),
        synthesisGuardrails: z
          .enum(['strict', 'lenient', 'off'])
          .optional()
          .describe(
            'Override guardrails when synthesize=true: strict closes to null on partial; lenient returns the answer with the verifier verdict; off skips the verifier',
          ),
        asOf: z.string().datetime().optional().describe('Knowledge as-of this ISO 8601 moment'),
        predicates: z.array(z.string()).optional().describe('Filter to these predicates only'),
        limit: z.number().int().min(1).max(100).optional(),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: tenant-global plus this user's personal facts; omit for tenant-global only",
          ),
      },
    },
    async (args, extra) => {
      const reporter = buildProgressReporter(extra as never);
      const out = await deps.multiHop.run({
        companyId,
        dto: {
          query: args.query,
          ...(args.maxHops !== undefined ? { maxHops: args.maxHops } : {}),
          ...(args.synthesize !== undefined ? { synthesize: args.synthesize } : {}),
          ...(args.synthesisGuardrails !== undefined
            ? { synthesisGuardrails: args.synthesisGuardrails }
            : {}),
          ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
          ...(args.predicates !== undefined ? { predicates: args.predicates } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.userId !== undefined ? { userId: args.userId } : {}),
        },
        callerScopes: scopes,
        onProgress: reporter,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  registerGraphRetrieveTool({ server, companyId, scopes, deps });

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
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Top-K facts fed to the generator (default 10)'),
        predicates: z.array(z.string()).optional(),
        asOf: z.string().datetime().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        synthesisGuardrails: z
          .enum(['strict', 'lenient', 'off'])
          .optional()
          .describe('Guardrail mode (default = SYNTHESIZE_DEFAULT_GUARDRAILS env)'),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: tenant-global plus this user's personal facts; omit for tenant-global only",
          ),
      },
    },
    async (args, extra) => {
      const reporter = buildProgressReporter(extra as never);
      const out = await deps.synth.synthesize({
        companyId,
        dto: {
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.predicates !== undefined ? { predicates: args.predicates } : {}),
          ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
          ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
          ...(args.synthesisGuardrails !== undefined
            ? { synthesisGuardrails: args.synthesisGuardrails }
            : {}),
          ...(args.userId !== undefined ? { userId: args.userId } : {}),
        },
        callerScopes: scopes,
        onProgress: reporter,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  registerMemoryDiffTool({ server, companyId, scopes, deps });
}

// Split out of registerSearchTools for the max-lines-per-function gate.
function registerMemoryDiffTool({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
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
        predicates: z.array(z.string()).optional().describe('Scope to these predicates'),
      },
    },
    async (args) => {
      const out = await deps.memoryDiff.diff(
        companyId,
        {
          from: args.from,
          to: args.to,
          ...(args.entityIds !== undefined ? { entityIds: args.entityIds } : {}),
          ...(args.predicates !== undefined ? { predicates: args.predicates } : {}),
        },
        scopes,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

// Split out of registerSearchTools for the max-lines-per-function gate.
function registerGraphRetrieveTool({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  server.registerTool(
    'graph_retrieve',
    {
      title: 'Graph-first retrieval around named entities',
      description:
        'Resolves the named entities by canonical name, walks their 1-hop neighbourhood over knowledge_edge, and returns facts across seeds ∪ neighbours, optionally filtered by predicate hints. Use when you already know WHICH entities the question is about and want what the graph knows around them ("who runs engineering at Acme" — the answer lives on a neighbour, not on Acme itself); use search_knowledge when you only have free text. Seeds score 1.0, neighbours 0.7; soft-fails to an empty result so you can fall back to search_knowledge.',
      inputSchema: {
        entityNames: z
          .array(z.string())
          .min(1)
          .describe('Canonical names of the entities to anchor on'),
        query: z
          .string()
          .optional()
          .describe('Free-text fallback used to resolve seeds when a name does not match exactly'),
        predicateHints: z
          .array(z.string())
          .optional()
          .describe(
            'Prefer facts with these predicates (non-matching neighbour facts are dropped, seed facts kept at lower score)',
          ),
        asOf: z.string().datetime().optional().describe('Knowledge as-of this ISO 8601 moment'),
      },
    },
    async (args) => {
      const out = await deps.search.graphRetrieve({
        companyId,
        queryText: args.query ?? args.entityNames.join(' '),
        entityRefs: args.entityNames,
        predicateHints: args.predicateHints ?? [],
        asOf: args.asOf,
        callerScopes: scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

function registerEntityReadTools({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
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
      const out = await deps.entities.getProfile({
        companyId,
        entityIdRaw: args.entityId,
        asOfRaw: args.asOf,
        scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
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
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: results include tenant-global facts plus this user's personal ones; omit for tenant-global only (fail-closed)",
          ),
      },
    },
    async (args) => {
      const out = await deps.entities.getTimeline({
        companyId,
        entityIdRaw: args.entityId,
        sinceRaw: args.since,
        untilRaw: args.until,
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
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
        entityId: z.string().describe('Brain entity id (knowledge_entity:...) or short id'),
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
        const out = await summarizeViaClientSampling({
          deps: { entities: deps.entities, summarizer: deps.summarizer },
          server,
          companyId,
          entityId: args.entityId,
          asOf: args.asOf,
          scopes,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: asStructuredContent(out),
        };
      }
      const out = await deps.summarizer.summarize(
        companyId,
        {
          entityId: args.entityId,
          ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
          ...(args.styleHint !== undefined ? { styleHint: args.styleHint } : {}),
        },
        scopes,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: {
          ...out,
          sampledBy: 'local_template',
        } as Record<string, unknown>,
      };
    },
  );

  // ── get_competing_facts ───────────────────────────────────────────
  server.registerTool(
    'get_competing_facts',
    {
      title: 'List competing facts for an entity',
      description:
        'Returns facts in COMPETING status — those the conflict resolver couldn\'t auto-supersede because two same-predicate bitemporal facts overlap in valid-time and are too cosine-close within margin. Grouped by (entityId, predicate); 2-fact groups are pairs the resolver left for adjudication, 3+-fact groups are multi-way disagreements escalated for human review. Use as preflight before record_fact ("is this entity already conflicted on this predicate?") or to drive an in-product reviewer queue. asOf filters to disagreements that were live at that moment.',
      inputSchema: {
        entityId: z.string().describe('Brain entity id (knowledge_entity:...) or short id'),
        predicate: z
          .string()
          .optional()
          .describe('Filter to one predicate (e.g. "status", "address")'),
        asOf: z
          .string()
          .datetime()
          .optional()
          .describe('Show what was competing at this ISO 8601 moment'),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: preflight a user-scoped record_fact against tenant-global priors PLUS this user's personal ones. Omit for tenant-global candidates (matches record_fact's userId)",
          ),
      },
    },
    async (args) => {
      const out = await deps.facts.listCompeting(companyId, args.entityId, {
        ...(args.predicate !== undefined ? { predicate: args.predicate } : {}),
        ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        callerScopes: scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  registerDetectContradictionTool({ server, companyId, scopes, deps });

  // ── get_fact / get_fact_provenance ────────────────────────────────
  // Registered only when the REST fact-read surface is switched on —
  // same conditional-registration idiom as ingest_document (agents
  // shouldn't see a tool that answers 404). The REST twin 404s behind
  // FACTS_API_ENABLED "indistinguishable from an absent route"; the MCP
  // analogue of an absent route is an absent tool (tools/list omits it,
  // a blind tools/call gets the SDK's standard unknown-tool error).
  // buildServer runs per request, so a flag flip applies on the next
  // request — exactly like the REST gate.
  if (envFlagEnabled(process.env.FACTS_API_ENABLED)) {
    registerFactReadTools({ server, companyId, scopes, deps });
  }

  // ── find_related_entities ─────────────────────────────────────────
  server.registerTool(
    'find_related_entities',
    {
      title: 'Find related entities',
      description: 'Get entities connected to the given one via the knowledge graph.',
      inputSchema: {
        entityId: z.string(),
        kind: z.string().optional().describe('Edge kind filter (e.g. "paid_for", "mentioned_in")'),
        asOf: z
          .string()
          .datetime()
          .optional()
          .describe(
            'Bitemporal edge cutoff — connections as they were believed at this ISO 8601 moment (mirrors GET /v1/entities/:id/connections?asOf=)',
          ),
      },
    },
    async (args) => {
      // Pass scopes — without them getConnections runs with an empty scope
      // set, which would drop the caller's PII/row entitlements at the
      // app-layer filter (the effective barrier; the DB-level PII fence is
      // inert for the system brain_caller user). Every other MCP tool
      // forwards scopes.
      const out = await deps.entities.getConnections({
        companyId,
        entityIdRaw: args.entityId,
        kind: args.kind,
        scopes,
        asOf: args.asOf,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

/**
 * Fact-level read surface (FACTS_API_ENABLED): the MCP twins of
 * GET /v1/facts/:id and GET /v1/facts/:id/provenance, delegating to the
 * same FactsService methods — one implementation of every visibility
 * fence (tenant pin, user scope, row policy; each an absence, never a
 * 403). Tool names equal the registry action ids (get_fact /
 * get_fact_provenance, both kind 'read'), so the ABAC + RFC 9396 grant
 * gates govern them exactly as they govern the REST routes.
 */
function registerFactReadTools({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  server.registerTool(
    'get_fact',
    {
      title: 'Get one fact by id',
      description:
        'Read a single fact as stored — predicate (aspect), object (statement), confidence, validity window, source attribution (vertical / recorder / conversationId), and lifecycle state. Retracted facts still resolve (retracted: true) — "why did I stop remembering this" is part of the trust story; only visibility fences turn into not-found. groundingStatus (grounded | ungrounded) appears on facts stamped by the claim-grounding plane (EVIDENCE_GROUNDING_STAMP); legacy rows carry no key. Same shape as GET /v1/facts/:id. Use after search_knowledge / record_fact when you hold a factId and need the full trust record behind it.',
      inputSchema: {
        factId: z.string().describe('Fact id (knowledge_fact:...) or short id'),
      },
    },
    async (args) => {
      const out = await deps.facts.getFact({
        companyId,
        factId: args.factId,
        scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  server.registerTool(
    'get_fact_provenance',
    {
      title: 'Show why a fact is remembered (grounding provenance)',
      description:
        'Return the grounding provenance behind one fact: the verbatim conversation turns it was derived from (episodes, chronological, with char-span quotes when the deriver stamped them). When the server runs with the recursive-closure flag the response additionally carries derivedFacts + closure (the transitive derivedFrom support graph); a plain deployment returns episodes only — the response is a passthrough of GET /v1/facts/:id/provenance, no field filtering. Traversal depth is a server-side policy (flag + caps), not a caller knob. Use to audit a surprising fact before trusting or retracting it.',
      inputSchema: {
        factId: z.string().describe('Fact id (knowledge_fact:...) or short id'),
      },
    },
    async (args) => {
      const out = await deps.facts.getProvenance({
        companyId,
        factId: args.factId,
        scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

// Split out of registerEntityReadTools (max-lines-per-function): the
// preflight dry-run tool for fn::resolve_fact.
function registerDetectContradictionTool({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  server.registerTool(
    'detect_contradiction',
    {
      title: 'Predict the conflict-resolver outcome for a candidate fact',
      description:
        'Dry-run preflight against fn::resolve_fact. Answers "if I were to record this fact right now, what would the resolver decide?" without writing to the database. wouldOutcome ∈ {INSERTED, SUPERSEDED, COMPETING, REJECTED}; reasoning explains which rule fired (semantics class, score gap vs margin, cosine threshold, etc); opposingFacts lists the same-predicate priors the resolver would have weighed against. Use before record_fact when the cost of a contested write is high (e.g. agent loops that pay an ingest credit). Fidelity: this preflight uses the SEED source-trust table and authority 0 — the live resolver scores opponents with the learned domain-scoped rates (migration 0045) and declared source authority (migration 0046), so predictions can differ for sources with conflict history or a registered authLevel; check get_source_reputation when precision matters.',
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
        sourceVertical: z.string().describe('Vertical attributed as source (matches record_fact)'),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Per-user memory scope: preflight a user-scoped record_fact against tenant-global priors PLUS this user's personal ones. Omit for tenant-global candidates (matches record_fact's userId)",
          ),
      },
    },
    async (args) => {
      const out = await deps.predictor.predict(
        companyId,
        {
          entityRef: args.entityRef,
          predicate: args.predicate,
          object: args.object,
          validFrom: args.validFrom,
          ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
          ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
          source: { vertical: args.sourceVertical },
          ...(args.userId !== undefined ? { userId: args.userId } : {}),
        },
        scopes,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

/**
 * Policy-action identity for each read-only MCP resource, keyed by the
 * resource NAME passed to server.registerResource. A resource is an
 * entity read, so it reuses the SAME action name as its equivalent read
 * tool: a grant or ABAC policy that allows (or denies) get_entity_profile
 * governs the brain://entity/<id> resource identically, and vice versa —
 * closing the gap where the tool gate covered tools but never resources.
 *
 * McpService's resource gate resolves a resource name through this map,
 * so the ABAC + RFC 9396 grant machinery covers resources exactly as it
 * covers tools. Keep this in lockstep with the registerResource calls
 * below — a new resource needs an entry here (an unmapped name falls
 * through to itself → write-kind → fail-closed under any restriction).
 */
export const READ_RESOURCE_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['entity-profile', 'get_entity_profile'],
  ['entity-timeline', 'get_entity_timeline'],
]);

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
 *
 * Each resource's policy action lives in READ_RESOURCE_ACTIONS above so
 * the McpService resource gate can ABAC/grant-check it like a tool.
 */
function registerReadResources({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
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
      const profile = await deps.entities.getProfile({
        companyId,
        entityIdRaw,
        asOfRaw: undefined,
        scopes,
      });
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
      const timeline = await deps.entities.getTimeline({
        companyId,
        entityIdRaw,
        sinceRaw: undefined,
        untilRaw: undefined,
        scopes,
      });
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
