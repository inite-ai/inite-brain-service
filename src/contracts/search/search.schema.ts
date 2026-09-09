import { z } from 'zod';

/**
 * Wire contracts for the headline read — POST /v1/search.
 *
 * Request mirrors SearchDto (src/search/dto/search.dto.ts); response
 * mirrors SearchService.search's envelope and SearchHit
 * (src/search/search.types.ts). Compile-time parity (samples typed
 * against the DTO / service types) and runtime parity (the samples
 * parse, key-for-key) are pinned by test/contracts-search.unit-spec.ts,
 * so a field added on one side without the other fails loudly.
 *
 * The request object is STRICT because the global ValidationPipe runs
 * with `forbidNonWhitelisted: true` (src/main.ts) — an unknown body key
 * is a 400, not a silent strip.
 */

/**
 * Per-fact score provenance, returned only for callers that asked for
 * it. Deliberately NOT field-level contracted: `breakdown` is an
 * `explain`-mode DEBUG payload whose components track the retrieval
 * pipeline's internals (ScoreBreakdown, src/search/internals/types.ts)
 * and change with every scoring lever. Pinning it here would publish a
 * promise the engine never made.
 */
export const ScoreBreakdownSchema = z.record(z.string(), z.unknown());

export const SearchRequestSchema = z.strictObject({
  /** Free-text query. Capped at 8 KB (SearchService re-clamps server-side). */
  query: z.string().max(8_000),
  /** Page size, 1–100. */
  limit: z.number().min(1).max(100).optional(),
  entityTypes: z.array(z.string()).optional(),
  predicates: z.array(z.string()).optional(),
  /**
   * Restrict to facts owned by these entities. Short (`cuid_abc`) and
   * fully-qualified (`knowledge_entity:cuid_abc`) forms are both
   * accepted — multi-hop anchors later hops with this.
   */
  entityIds: z.array(z.string()).optional(),
  /** ISO-8601 world-time anchor (bitemporal slice). */
  asOf: z.string().optional(),
  /**
   * Per-user memory scope (migration 0055): results become
   * tenant-global PLUS this user's personal rows. Omitted =
   * tenant-global only (fail-closed).
   */
  userId: z.string().max(200).optional(),
  /** Floor on the raw stored `confidence` field. */
  minConfidence: z.number().min(0).max(1).optional(),
  includeContested: z.boolean().optional(),
  includeRetracted: z.boolean().optional(),
  /**
   * Revert to the audit shape — every active-status fact ever ingested,
   * including ones whose validity window has passed. Default search is
   * Datomic-style "actual now".
   */
  includeStale: z.boolean().optional(),
  /** `hybrid` (default) fuses vector + BM25; `vector` / `lexical` run one leg. */
  searchMode: z.enum(['vector', 'lexical', 'hybrid']).optional(),
  /** Floor applied AFTER decay + source-trust weighting (stricter than minConfidence). */
  confidenceFloor: z.number().min(0).max(1).optional(),
  /** Drop facts whose ingest path preserved no source trail. */
  requireProvenance: z.boolean().optional(),
  /** Response cap in tokens (cl100k_base), 50–50000. */
  tokenBudget: z.number().min(50).max(50_000).optional(),
  outputShape: z.enum(['full', 'compact', 'ids']).optional(),
  /** ISO 639-1 hint; drives the lang-filtered pass + cross-lingual backoff. */
  queryLang: z.string().optional(),
  /** Debug escape hatch: skip the language-aware pass entirely. */
  disableLangFilter: z.boolean().optional(),
});

export const SearchFactSchema = z.object({
  factId: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number(),
  validFrom: z.string(),
  validUntil: z.string().optional(),
  status: z.string(),
  /** Write-time source key (trustSnapshot, 0044) — chase a citation to its claimer. */
  sourceKey: z.string().optional(),
  /** Event time of the fact's first grounding turn (DERIVER_MENTION_STAMP). */
  mentionedAt: z.string().optional(),
  /** One clause of encoding context — the situation the fact was learned in (V13). */
  scene: z.string().optional(),
  /** BM25 snippet with `<em>` around matched terms (SEARCH_HIGHLIGHT_ENABLED). */
  highlight: z.string().optional(),
  score: z.number(),
  breakdown: ScoreBreakdownSchema.optional(),
});

export const SearchHitSchema = z.object({
  entityId: z.string(),
  entityType: z.string(),
  canonicalName: z.string(),
  externalRefs: z.record(z.string(), z.string()),
  facts: z.array(SearchFactSchema),
  score: z.number(),
});

export const SearchResponseSchema = z.object({
  results: z.array(SearchHitSchema),
  /**
   * Retrieval stages that were skipped on this request. Present only when
   * non-empty. `vector_leg`: the query could not be embedded (embedder
   * warming up or down) or the similarity query failed, so `results` is a
   * lexical-only ranking — complete for keyword matches, blind to semantic
   * ones. Retry later for the full ranking.
   */
  degraded: z.array(z.enum(['vector_leg'])).optional(),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
