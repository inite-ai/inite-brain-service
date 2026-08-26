/**
 * Public types + constants for the predicate registry. Kept separate
 * from the service so consumers (extractor, chat-router) can import
 * type-only without dragging in NestJS DI.
 */

import type { EvidenceCapability } from '../../synthesize/synthesize.types';

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';
export type PiiClass = 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
export type PredicateStatus = 'active' | 'proposed' | 'aliased' | 'deprecated';

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
  /**
   * 0113 (FOVEA_EVIDENCE_CAPABILITY): the evidence capability a claim
   * under this predicate REQUIRES to verify — absent = 'text' =
   * unconstrained (every CORE seed). A verdict-gate policy, not an
   * extractor concern: deliberately NOT folded into computeHash (the
   * extractor cache key, db-mapping.ts) — serving picks up an operator
   * edit via the snapshot TTL, and an extraction made against the old
   * value is still valid.
   */
  requiredEvidenceCapability?: EvidenceCapability;
  parentPredicateId?: string;
  subjectClasses?: string[];
  allowedValues?: string[];
  status: PredicateStatus;
  aliasedTo?: string;
  createdBy: 'system' | 'admin' | 'llm_auto' | 'migration';
}

/**
 * A single few-shot example a Domain Pack ships in its extraction profile.
 * Rendered into the extractor system prompt as illustrative TEXT (not a
 * schema-constrained message turn), so it can never violate the strict JSON
 * response schema. `text` is a sample input snippet; `note` says what a correct
 * extraction should capture from it.
 */
export interface ExtractionExample {
  text: string;
  note: string;
}

/**
 * A Domain Pack's extraction profile — domain-specific tuning for the LLM
 * extractor, carried in the pack manifest (docs/domain-packs.md) and CONSUMED
 * at extract time. `guidance` is domain framing appended to the extractor
 * system prompt; `fewShot` are illustrative examples. Both are advisory: they
 * never override the VERBATIM RULE or the strict output schema.
 */
export interface ExtractionProfile {
  guidance?: string;
  fewShot?: ExtractionExample[];
}

/** A pack's extraction profile paired with its origin pack id, as assembled
 *  onto the tenant snapshot from installed + builtin packs. */
export interface PackExtractionProfile {
  packId: string;
  profile: ExtractionProfile;
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
  /** Extraction profiles contributed by the tenant's active packs (builtin +
   *  runtime-installed). Injected into the extractor system prompt so a pack
   *  can tune extraction for its domain. Empty when no active pack ships one. */
  extractionProfiles: PackExtractionProfile[];
  /**
   * Every non-deprecated predicateId (active + aliased + proposed).
   * canonicalize()'s short-circuit checks it so a REPEAT coinage of a
   * 'proposed' predicate resolves in-cache — before 0082's alias pass
   * the repeat path embedded the context and hit a UNIQUE violation on
   * re-insert EVERY time (bounded nuisance under closed vocabulary, an
   * O(n²) registry storm under open). Optional: legacy snapshot
   * literals in tests omit it; consumers treat absent as empty.
   */
  knownIds?: Set<string>;
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
  description: 'Synthesised fallback when a predicate is not in the registry.',
  datatype: 'string',
  // W3 (audit 2026-08 #2): a predicate NOT in the registry is a coined,
  // open-vocabulary observation — history matters, and `bitemporal`
  // supersede/compete semantics were invented for closed CRM predicates.
  // Closed-vocabulary seeds keep their per-predicate policies; only the
  // unknown-predicate fallback (and the 'proposed' rows canonicalize
  // creates from it) defaults to append_only.
  semantics: 'append_only',
  decayHalfLifeDays: 60,
  piiClass: 'none',
  status: 'active',
  createdBy: 'system',
};
