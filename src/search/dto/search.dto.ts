import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

export type SearchMode = 'vector' | 'lexical' | 'hybrid';

export class SearchDto {
  // Realistic queries fit in a few hundred chars; cap at 8 KB so a
  // malicious caller can't fan a multi-MB string into the BM25 leg,
  // embedding call, and synthesize prompt. SearchService also clamps
  // server-side as defence-in-depth in case a future endpoint accepts
  // a body shape that bypasses this DTO.
  @IsString()
  @MaxLength(8_000)
  query: string;

  @IsOptional() @IsNumber() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  entityTypes?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  predicates?: string[];

  /**
   * Restrict search to facts owned by these entity ids. Primary use
   * case is multi-hop chaining: hop N anchors on entityIds emitted by
   * hop N-1 so the second sub-query is scoped to candidates already
   * known to satisfy the first. Either short ids (`cuid_abc`) or
   * fully-qualified (`knowledge_entity:cuid_abc`) form is accepted —
   * the search service normalises both into the SurrealDB record
   * link form before the WHERE clause.
   */
  @IsOptional() @IsArray() @IsString({ each: true })
  entityIds?: string[];

  @IsOptional() @IsISO8601()
  asOf?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  minConfidence?: number;

  @IsOptional() @IsBoolean()
  includeContested?: boolean;

  @IsOptional() @IsBoolean()
  includeRetracted?: boolean;

  /**
   * Bitemporal escape hatch. When true, default search returns ALL
   * facts brain knows about regardless of validity-window position
   * (still excludes retracted unless `includeRetracted` is also set).
   *
   * Brain's default-search semantics is Datomic-style "actual now":
   * we return only facts whose validity interval contains the query
   * moment AND whose status is one of {active, competing}. That's
   * what 95% of agentic / customer-data callers want — "tell me
   * what's true right now".
   *
   * `includeStale: true` reverts to the audit shape — every active-
   * status fact ever ingested, including ones whose validUntil has
   * passed and ones that have been superseded. Pair with `asOf`
   * for explicit historical / reasoning-trail queries when you
   * need a bounded window. Most callers should use `asOf` instead.
   */
  @IsOptional() @IsBoolean()
  includeStale?: boolean;

  /**
   * Retrieval strategy. `hybrid` (default) runs vector + BM25 in
   * parallel and fuses via reciprocal-rank fusion. `vector` is
   * embedding-only — best for paraphrastic / cross-lingual queries.
   * `lexical` is BM25-only — useful when callers want exact-token
   * matching (id lookups, regulatory queries) without semantic drift.
   */
  @IsOptional() @IsIn(['vector', 'lexical', 'hybrid'])
  searchMode?: SearchMode;

  // ── KnowQL-lite agent primitives (cf. Pinecone Nexus, May 2026) ──
  // Brain is fact-based, so the canonical KnowQL six-primitive set
  // (intent, filter, provenance, output shape, confidence, budget)
  // partly maps to fields above and partly to the new ones below:
  //   intent      → built into `query` + searchMode
  //   filter      → predicates / entityTypes / asOf / minConfidence
  //   provenance  → requireProvenance (new)
  //   output shape→ outputShape       (new)
  //   confidence  → confidenceFloor   (new, sharper than minConfidence)
  //   budget      → tokenBudget       (new — caps response size)

  /**
   * Reject facts whose `confidence` is below this threshold AFTER
   * decay-and-source-trust weighting. Stricter than `minConfidence`
   * (which gates the raw fact field). For agentic callers that
   * cannot tolerate noisy hits, set this to ≥0.5.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(1)
  confidenceFloor?: number;

  /**
   * When true, every returned fact must carry a non-empty `source`
   * object. Strips facts whose ingest path didn't preserve a
   * vertical/eventId/messageId trail. Useful for compliance flows
   * where the agent must cite-and-link back to the originating event.
   */
  @IsOptional() @IsBoolean()
  requireProvenance?: boolean;

  /**
   * Response size cap, in tokens. Server drops entities (lowest-score
   * first) until the projected JSON-serialised response fits. Counted
   * exactly via tiktoken's cl100k_base encoding — the same encoding
   * downstream OpenAI / Anthropic billing uses, so the budget the
   * caller specifies is the budget they'll actually consume.
   */
  @IsOptional() @IsNumber() @Min(50) @Max(50_000)
  tokenBudget?: number;

  /**
   * Response shape:
   *   `full`    — entities + facts + scores (default, current behaviour)
   *   `compact` — entities + top fact per entity, no scores
   *   `ids`     — entity ids only (cheapest; agent re-fetches what it needs)
   */
  @IsOptional() @IsIn(['full', 'compact', 'ids'])
  outputShape?: 'full' | 'compact' | 'ids';

  /**
   * Phase 4.B locale-aware retrieval. ISO 639-1 hint for the query
   * language. When supplied (or detected from the query), the
   * search runs a TWO-PASS strategy:
   *   1. lang-filtered pass — restrict to facts where
   *      `lang = queryLang OR lang IS NONE`
   *   2. cross-lingual backoff — if the filtered pass returns fewer
   *      than `limit` hits, second pass relaxes the lang filter so
   *      semantically-matching facts in other languages still
   *      surface (BGE-M3-style cross-lingual recall path).
   *
   * Omitting `queryLang` falls back to the existing single-pass
   * behaviour — back-compat preserved.
   */
  @IsOptional() @IsString()
  queryLang?: string;

  /**
   * Disable the language-aware retrieval pass entirely (debug
   * escape hatch). When true, the where-builder skips the lang
   * filter even if `queryLang` was supplied or detected.
   */
  @IsOptional() @IsBoolean()
  disableLangFilter?: boolean;
}
