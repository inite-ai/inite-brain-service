/**
 * Internal row shapes used by the retrieval stages.
 * Keeps the public SearchHit (response surface) separate from FactRow
 * (DB projection), so each stage can be typed precisely.
 */

/**
 * Stage label identifying which retrieval leg surfaced a fact.
 * Carried end-to-end so DecisionLog can attribute each retrieved fact
 * to the provenance activity that found it (HippoRAG/PROV-style).
 */
export type RetrievalStage =
  'vector' | 'lexical' | 'graph_seed' | 'graph_neighbour' | 'edge_expansion' | 'ppr' | 'segment';

/** One graph edge to a neighbour entity, as projected by both the edge-
 *  expansion query and (under SEARCH_COMBINED_VECTOR_GRAPH) the vector leg.
 *  `peer.userId` feeds the edge-fence peer check (edge-fence.ts) — a
 *  user-scoped peer entity is invisible outside its own user's calls. */
export interface NeighbourEdge {
  kind: string;
  weight?: number;
  peer: { id: unknown; userId?: string | null } | null;
}

export interface FactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  /** EDC-canonical id for a coined predicate (0082); predicate-keyed
   *  consumers (policy, chatter, diversity) use `predicateAlias ?? predicate`. */
  predicateAlias?: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
  status: string;
  // The persisted fact `source` is an open, heterogeneous object: a
  // FactSource core plus fields various write paths stamp on top
  // (mentionedAt, scene, salience, originKey). Modelled as an open record
  // (or null, for the insight/synthetic legs that carry no source);
  // consumers read individual fields defensively (e.g. scoring reads
  // `source?.evidence` via optional chaining).
  source: Record<string, unknown> | null;
  // Hydrated via inline projection — entity record inlined.
  entity?: {
    id: unknown;
    type: string;
    canonicalName: string;
    externalRefs?: Record<string, string>;
    mergedInto?: unknown;
  };
  // Graph neighbourhood of this fact's entity, projected inline by the vector
  // leg when SEARCH_COMBINED_VECTOR_GRAPH is on (KNN + graph traversal in one
  // query). Absent otherwise; edge-expansion then does its own lookup.
  outNeighbours?: NeighbourEdge[] | null;
  inNeighbours?: NeighbourEdge[] | null;
  // One of these is set per row depending on which leg surfaced it;
  // hybrid mode merges both and lets the fusion stage combine. Field
  // names sidestep the SurrealQL `vec::*` and `lex::*` namespace
  // prefixes — using `vec` or `lex` as a SELECT alias confuses the
  // parser's `ORDER BY` resolver and silently returns rows in
  // record-id order instead of by score.
  simScore?: number;
  bm25Score?: number | undefined;
  /** BM25 match snippet from search::highlight, set by the lexical leg when
   *  SEARCH_HIGHLIGHT_ENABLED is on. Absent on vector-only rows. */
  highlight?: string;
  /**
   * Write-time source-trust snapshot (migration 0044) — read straight
   * off the row so trust can enter ranking without a join. Absent on
   * pre-0044 facts (degrades to the neutral 0.5 in scoring).
   */
  trustSnapshot?: {
    sourceKey?: string;
    domain?: string;
    declaredTrust?: number;
    learnedTrust?: number;
    authority?: number;
  } | null;
  /** Cross-source confirmation counter (migration 0047), incumbent-side.
   *  originKeys (0050) feed the ABAC effective-meta union. */
  corroboration?: {
    count?: number;
    sourceKeys?: string[];
    originKeys?: string[];
  } | null;
  /**
   * Per-user memory scope owner (migration 0055); NONE = tenant-global.
   * Projected so the ABAC row filter can match userId policies.
   */
  userId?: string | null;
  /**
   * Usage reinforcement (migration 0053): most recent time search
   * surfaced this fact, attached by enrichWithUsage when
   * SEARCH_USAGE_DECAY_ENABLED is on. Absent → decay from recordedAt
   * exactly as before.
   */
  lastReadAt?: string;
  /**
   * Usage reinforcement (migration 0053): how many times search has
   * surfaced this fact, attached by enrichWithUsage when
   * SEARCH_USAGE_RANKING_ENABLED is on (G8 trace-derived ranking).
   * Absent → treated as 0 → usageFactor exactly 1.0.
   */
  readCount?: number;
  /**
   * Set of stages that surfaced this row. Multi-stage hits are common
   * (e.g. vector + graph_seed) — the set lets DecisionLog show every
   * contributing path without losing the dominant origin.
   */
  stages?: RetrievalStage[];
}

export type FusedRow = FactRow & { fusedScore: number };

/**
 * Per-fact score breakdown — every multiplicative component is kept
 * separate so the DecisionLog can show why this fact beat the others.
 *
 *  Phase 1 fields: fusedScore, confidence, decay, finalScore,
 *                  stages.
 *  Phase 3 additions: calibratedConfidence (isotonic-mapped raw),
 *                  extractionEntropy (semantic entropy across N
 *                  extraction passes — Farquhar 2024 / Nikitin 2024),
 *                  conformalPValue (Phase 3.C guardrail signal).
 *
 * All new fields are optional so callers that only read the Phase 1
 * shape continue to compile and run.
 */
export interface ScoreBreakdown {
  fusedScore: number;
  confidence: number;
  /** Phase 3: isotonic-mapped raw → calibrated. Omitted when disabled. */
  calibratedConfidence?: number;
  /** Phase 3: semantic-entropy across N extraction passes. Omitted on N=1. */
  extractionEntropy?: number;
  /** Phase 3.C: conformal p-value for the synthesize-side guardrail. */
  conformalPValue?: number;
  decay: number;
  /**
   * Sub-1.0 chatter demotion applied to `said` facts (SEARCH_CHATTER_PENALTY).
   * Omitted when 1.0 (no penalty) so unpenalised rows are byte-identical.
   */
  chatterPenalty?: number;
  /**
   * Interval-overlap decay vs the asOf anchor (profile temporalMode =
   * 'overlap_boost', audit W4 #17). Omitted when 1.0 — i.e. the fact's
   * validity interval contains the anchor, or no anchor was set.
   */
  temporalOverlap?: number;
  /**
   * V13 time-filter factor vs the query-named period (profile
   * timeFilter). Omitted when 1.0 — the fact overlaps the period, no
   * period parsed, or the filter is off.
   */
  timeRange?: number;
  /**
   * V8 §4 importance factor from the deriver-stamped source.salience
   * (profile salienceScoring). Omitted when 1.0 — scoring off, an
   * unstamped row, or the neutral grade.
   */
  salience?: number;
  /**
   * G8 trace-derived ranking (Spectron "eight signals"): the usage
   * signal's "because" decomposition — the raw fact_usage.readCount and
   * the multiplicative `1 + β·squash(readCount)` term it produced.
   * Omitted when the factor is exactly 1.0 (SEARCH_USAGE_RANKING_ENABLED
   * off, SEARCH_USAGE_BETA 0, or a fact search has never surfaced) so
   * unaffected rows stay byte-identical.
   */
  usage?: {
    readCount: number;
    usageFactor: number;
  };
  /**
   * Source-reputation track, Phase 5: the "because" decomposition of the
   * fact's trust as it entered ranking. sourceReputation is the
   * write-time snapshot ladder (learnedTrust ?? declaredTrust ?? 0.5 —
   * pre-0044 facts land on the neutral); trustFactor/corroborationFactor
   * are the multiplicative terms applied to finalScore (both exactly 1.0
   * while SEARCH_TRUST_BETA / SEARCH_CORROBORATION_GAMMA stay 0).
   */
  factTrust?: {
    sourceReputation: number;
    authority: number;
    corroborationCount: number;
    evidenceCount: number;
    trustFactor: number;
    corroborationFactor: number;
    /**
     * Multiplicative term `1 + δ·authority` (SEARCH_AUTHORITY_DELTA);
     * exactly 1.0 while δ stays 0 or the source has no registry entry.
     */
    authorityFactor?: number;
  };
  finalScore: number;
  stages: RetrievalStage[];
}

export type ScoredRow = {
  row: FusedRow;
  score: number;
  breakdown: ScoreBreakdown;
};

export interface EntityBucket {
  entityId: string;
  rankScore: number;
  bestScore: number;
  facts: ScoredRow[];
}
