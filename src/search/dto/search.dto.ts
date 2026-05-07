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
} from 'class-validator';

export type SearchMode = 'vector' | 'lexical' | 'hybrid';

export class SearchDto {
  @IsString()
  query: string;

  @IsOptional() @IsNumber() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  entityTypes?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  predicates?: string[];

  @IsOptional() @IsISO8601()
  asOf?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1)
  minConfidence?: number;

  @IsOptional() @IsBoolean()
  includeContested?: boolean;

  @IsOptional() @IsBoolean()
  includeRetracted?: boolean;

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
   * Approximate response size cap, in tokens. Server trims facts
   * (top-by-score first) until the projected response fits. Tokens
   * are estimated as `chars / 4` — a coarse but free heuristic
   * that matches OpenAI's sub-word tokenizer within ~15%.
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
}
