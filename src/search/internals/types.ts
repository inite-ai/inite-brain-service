/**
 * Internal row shapes used by the retrieval stages.
 * Keeps the public SearchHit (response surface) separate from FactRow
 * (DB projection), so each stage can be typed precisely.
 */

export interface FactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
  status: string;
  source: any;
  // Hydrated via inline projection — entity record inlined.
  entity?: {
    id: unknown;
    type: string;
    canonicalName: string;
    externalRefs?: Record<string, string>;
    mergedInto?: unknown;
  };
  // One of these is set per row depending on which leg surfaced it;
  // hybrid mode merges both and lets the fusion stage combine. Field
  // names sidestep the SurrealQL `vec::*` and `lex::*` namespace
  // prefixes — using `vec` or `lex` as a SELECT alias confuses the
  // parser's `ORDER BY` resolver and silently returns rows in
  // record-id order instead of by score.
  simScore?: number;
  bm25Score?: number;
}

export type FusedRow = FactRow & { fusedScore: number };

export type ScoredRow = { row: FusedRow; score: number };

export interface EntityBucket {
  entityId: string;
  rankScore: number;
  bestScore: number;
  facts: ScoredRow[];
}
