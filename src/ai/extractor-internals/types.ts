/**
 * Public type surface for the extractor pipeline. Shared by the
 * service, prompts, validators, and local-synth modules.
 */

export interface ExtractedEntity {
  name: string;
  type:
    | 'customer'
    | 'staff'
    | 'asset'
    | 'project'
    | 'topic'
    | 'location'
    | 'other';
  /** Optional canonical clue ("Apple Inc.", "Acme Corp"). */
  canonical?: string;
}

export interface ExtractedFact {
  entityIndex: number;
  predicate: string;
  object: string;
  confidence: number;
  /** The clause this fact was anchored to (verbatim sub-span). */
  clause?: string;
  /**
   * Semantic entropy across the N stochastic re-rolls (Farquhar et al.,
   * Nature 2024). Only populated when EXTRACTOR_SC_PASSES > 1; absent
   * on single-pass extractions. The value is the cluster entropy (nats)
   * over the per-fact clustering; a single dominant cluster collapses
   * to ~0, an even spread approaches log(N).
   */
  extractionEntropy?: number;
  /**
   * Fraction of passes that surfaced this fact's cluster ∈ [0, 1] (CISC,
   * ACL findings 2025). 1 means every pass agreed; 1/N means the cluster
   * only appeared once. Same emission gate as extractionEntropy.
   */
  extractionAgreement?: number;
}

export interface ExtractedEdge {
  fromEntityIndex: number;
  toEntityIndex: number;
  /** Lowercase snake_case relationship type. */
  kind: string;
  confidence: number;
  /** Optional verbatim clause that warranted this edge. */
  clause?: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  edges: ExtractedEdge[];
}

/** Raw fact shape as it arrives from the LLM, pre-validation. */
export interface RawExtractedFact {
  entityIndex: number;
  clauseIndex: number | undefined;
  predicate: string;
  valueSpan: string;
  confidence: number;
}

export const ENTITY_TYPE_VOCABULARY = [
  'customer',
  'staff',
  'asset',
  'project',
  'topic',
  'location',
  'other',
] as const;
