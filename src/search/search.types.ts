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
  /**
   * The entity's 1-hop graph relations — `knowledge_edge` rows the
   * extractor wrote instead of, or as well as, a fact. Absent when none
   * were fetched. They are EVIDENCE: the extractor files "works at
   * Orbital Dynamics" as a fact in one language and as an edge in
   * another, and an answer plane that saw only facts had the generator
   * asserting an employer the verifier could not find, and dropping the
   * answer.
   */
  relations?: Array<{
    kind: string;
    peer: string;
    peerType: string;
    /** The peer entity's id — the asker's own entity renders as "you" by it. */
    peerId?: string | undefined;
    /** The knowledge_edge record behind the relation (citable). */
    edgeId?: string | undefined;
    /** 'out' = this entity is the subject of the relation; 'in' = its object. */
    direction?: 'out' | 'in' | undefined;
    /** Valid time (0164): when the relation began / stopped holding. */
    validFrom?: string | undefined;
    validUntil?: string | undefined;
  }>;
  facts: Array<{
    factId: string;
    /** As written — the coinage this fact was stored under. */
    predicate: string;
    /**
     * The canon this predicate was aliased onto (0083), when it was.
     * Identity is `predicateAlias ?? predicate` everywhere downstream:
     * ranking, diversity, the T5 recency slot, and the cross-plane join
     * with the belief plane's own slot (0147). Absent = its own canon.
     */
    predicateAlias?: string | undefined;
    object: string;
    /**
     * The calendar day (YYYY-MM-DD) the value refers to — a deadline, a
     * meeting, an occurrence — as the extractor resolved it at write
     * time (objectMeta.date). Absent when the value names no day.
     */
    date?: string | undefined;
    confidence: number;
    validFrom: string;
    validUntil?: string | undefined;
    /**
     * When the temporary state this fact states is expected to be over
     * (0166): inferred at write time from what the state is — an
     * illness, a trip. An expectation, not an end; the answer plane
     * renders it and, once past, says nothing has confirmed the state
     * since. Absent for everything that holds until changed.
     */
    expectedUntil?: string | undefined;
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
