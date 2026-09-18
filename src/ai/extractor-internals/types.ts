/**
 * Public type surface for the extractor pipeline. Shared by the
 * service, prompts, validators, and local-synth modules.
 */

export interface ExtractedEntity {
  name: string;
  type: 'customer' | 'staff' | 'asset' | 'project' | 'topic' | 'location' | 'other';
  /** Optional canonical clue ("Apple Inc.", "Acme Corp"). */
  canonical?: string | undefined;
  /**
   * The knowledge_entity this mention refers to, when the extractor
   * pinned it to one of the KNOWN ENTITIES of its memory context
   * (memory-context.ts). The persister files the mention under it
   * directly — no resolution ladder, no judge. Absent for a mention the
   * memory did not already hold.
   */
  known?: string | undefined;
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
  clause?: string | undefined;
  /**
   * The calendar day (YYYY-MM-DD) the value refers to — a deadline, a
   * meeting, when something happened — resolved by the extractor
   * against the turn's date. Absent when the clause names no date.
   */
  eventTime?: string | undefined;
  /**
   * knowledge_fact ids this fact replaces: the KNOWN FACTS of the memory
   * context the extractor judged to be the previous value of the same
   * attribute (a cut budget, a moved date, a changed state). The
   * persister closes them the moment the new fact lands, whatever
   * predicate they were spelled under. Empty/absent = nothing changes.
   */
  supersedes?: string[] | undefined;
  /**
   * How many values of this attribute the subject holds at one time, as
   * the extractor read it in the sentence: "one" — a setting or a state,
   * a later value replaces the earlier one; "many" — several coexist.
   * Decides a coined predicate's semantics at registration (single_active
   * / append_only) without a second model call; absent for an extractor
   * without the contract, and the registry's judge decides then.
   */
  cardinality?: FactCardinality | undefined;
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
  /** YYYY-MM-DD the value refers to (memory-context contract); absent when none. */
  eventTime?: string;
  /** knowledge_fact ids this one replaces — handles already mapped by the parser. */
  supersedes?: string[];
  /** "one" | "many" — the attribute's cardinality over time (memory-context contract). */
  cardinality?: FactCardinality;
}

/** How many values of an attribute its subject holds at one time. */
export type FactCardinality = 'one' | 'many';

export function parseCardinality(raw: unknown): FactCardinality | undefined {
  return raw === 'one' || raw === 'many' ? raw : undefined;
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
