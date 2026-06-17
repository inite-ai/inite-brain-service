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
