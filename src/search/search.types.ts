import type { ScoreBreakdown } from './internals/types';

/**
 * Public response surface for /v1/search.
 *
 * Kept separate from the orchestrator so consumers (controllers,
 * multi-hop, synthesize) and the internal stage modules can import
 * the type without dragging in the full SearchService class.
 *
 * `breakdown` is optional and only populated when the caller requested
 * `explain=true`. It carries the per-fact scoring components and the
 * retrieval-stage provenance needed to render a DecisionLog.
 */
export interface SearchHit {
  entityId: string;
  entityType: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    validFrom: string;
    validUntil?: string | undefined;
    status: string;
    /** Write-time source key (trustSnapshot, migration 0044) — lets a
     *  caller chase a citation back to WHO claimed it. Absent on
     *  pre-0044 facts. */
    sourceKey?: string | undefined;
    /** DERIVER_MENTION_STAMP anchor (V12 §1): event time of the fact's
     *  first grounding turn, from source.mentionedAt. Absent on
     *  unstamped rows. */
    mentionedAt?: string;
    /**
     * V13 scene trace (DERIVER_SCENE_TRACE, source.scene): one clause
     * of encoding context — the situation the fact was learned in.
     * Rendered onto fact lines under RETRIEVAL_SCENE_TRACES.
     */
    scene?: string;
    /** BM25 match snippet with <em>…</em> around the matched terms, from
     *  search::highlight (SEARCH_HIGHLIGHT_ENABLED). Present only for
     *  lexically-matched facts when the flag is on. */
    highlight?: string;
    score: number;
    breakdown?: ScoreBreakdown;
  }>;
  score: number;
}
