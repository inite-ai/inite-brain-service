/**
 * Public types + constants for the predicate registry. Kept separate
 * from the service so consumers (extractor, chat-router) can import
 * type-only without dragging in NestJS DI.
 */

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';
export type PiiClass =
  | 'none'
  | 'identifier'
  | 'behavioral'
  | 'text'
  | 'sensitive';
export type PredicateStatus =
  | 'active'
  | 'proposed'
  | 'aliased'
  | 'deprecated';

export interface PredicateDefinition {
  predicateId: string;
  displayLabel: string;
  /**
   * Multi-line description fed to the extractor's system prompt as a
   * predicate "card". Should encode TYPE / ADMIT / NOT FOR / VALUE
   * — operators editing this field directly tune extractor behaviour
   * without code changes.
   */
  description: string;
  /** Storage datatype the value should conform to (string default). */
  datatype: 'string' | 'number' | 'date' | 'datetime' | 'enum' | 'json';
  semantics: Semantics;
  decayHalfLifeDays: number | null;
  piiClass: PiiClass;
  requiresScope?: string;
  parentPredicateId?: string;
  subjectClasses?: string[];
  allowedValues?: string[];
  status: PredicateStatus;
  aliasedTo?: string;
  createdBy: 'system' | 'admin' | 'llm_auto' | 'migration';
}

export interface PredicateSnapshot {
  /** Stable hash of the active-row-set; pinned to extractor traces. */
  versionHash: string;
  /** All predicates with status='active'. */
  active: PredicateDefinition[];
  /** Quick lookup by predicateId (active only). */
  byId: Map<string, PredicateDefinition>;
  /** Resolved aliases. Maps any (aliased / active / proposed) predicate
   *  id to its CANONICAL active predicate id by following aliasedTo
   *  chains. Drives canonicalize() and read-time predicate normalization. */
  aliasMap: Map<string, string>;
  /** Embedding lookup for active predicates — drives EDC similarity
   *  search on canonicalize(). Predicates without an embedding are
   *  skipped during similarity scoring (older rows from before 0012
   *  migration). */
  embeddings: Map<string, number[]>;
}

export type CanonicalizeDecision =
  | { kind: 'matched'; canonicalId: string }
  | {
      kind: 'aliased';
      canonicalId: string;
      similarity: number;
      novelPredicateId: string;
    }
  | {
      kind: 'proposed';
      canonicalId: string;
      novelPredicateId: string;
      bestMatch?: { predicateId: string; similarity: number };
    };

export const SNAPSHOT_TTL_MS = 60_000;
/** Default EDC similarity threshold for auto-alias. */
export const DEFAULT_CANONICALIZE_AUTO_ALIAS_THRESHOLD = 0.85;
/** Floor for "any meaningful match" — used purely to report bestMatch
 *  on the proposed outcome so an operator reviewing the queue sees
 *  what the closest existing predicate was. */
export const CANONICALIZE_REPORT_FLOOR = 0.6;

export const DEFAULT_FALLBACK: PredicateDefinition = {
  predicateId: '__default__',
  displayLabel: 'default',
  description:
    'Synthesised fallback when a predicate is not in the registry.',
  datatype: 'string',
  semantics: 'bitemporal',
  decayHalfLifeDays: 60,
  piiClass: 'none',
  status: 'active',
  createdBy: 'system',
};
