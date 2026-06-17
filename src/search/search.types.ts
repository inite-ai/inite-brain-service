/**
 * Public response surface for /v1/search.
 *
 * Kept separate from the orchestrator so consumers (controllers,
 * multi-hop, synthesize) and the internal stage modules can import
 * the type without dragging in the full SearchService class.
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
    validUntil?: string;
    status: string;
    score: number;
  }>;
  score: number;
}
