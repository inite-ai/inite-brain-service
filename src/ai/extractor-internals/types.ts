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
  /**
   * EDC-canonical id for a coined predicate (0082, open vocabulary
   * only). The raw coinage stays in `predicate` — specificity is the
   * dialogue profile's whole point — while resolution, dedup and the
   * read-side predicate consumers key on `predicateAlias ?? predicate`.
   * Absent when the predicate is already canonical (registry hit or a
   * novel coinage that became its own canon).
   */
  predicateAlias?: string;
  object: string;
  confidence: number;
  /** The clause this fact was anchored to (verbatim sub-span). */
  clause?: string;
  /**
   * The verbatim grounded span the object was derived from. Equal to
   * `object` unless object normalization rewrote the stored value
   * (EXTRACTION_OBJECT_NORMALIZE); kept for audit and pattern-cache
   * matching either way.
   */
  valueSpan?: string;
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
  /**
   * LLM-proposed NORMALIZED value (EXTRACTION_OBJECT_NORMALIZE): the
   * minimal clean phrase naming the value, derived from valueSpan.
   * Server-validated — every content word must appear in the grounded
   * span (anti-hallucination stays structural); invalid proposals fall
   * back to the span. Absent when the flag is off.
   */
  object?: string;
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
