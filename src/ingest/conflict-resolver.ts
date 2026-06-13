/**
 * Conflict resolution scoring + predicate-policy TYPE definitions.
 *
 * Historical note: this file used to host a hardcoded PREDICATE_POLICIES
 * table. That table has moved to the per-tenant SurrealDB registry
 * (see src/ai/predicate-registry.service.ts and migration 0011) so
 * operators can extend the ontology without code changes. What stays
 * here is the TYPE definitions, the DEFAULT fallback policy, and the
 * conflict-resolution math (scoring, recency decay) — those are
 * codebase-wide invariants, not per-tenant ontology data.
 *
 * Predicate semantics — four classes, two axes (cardinality × time-behavior):
 *
 *   - `single_active` — functional (one true value at a time), time-varying.
 *     On overlap with a new fact, the prior is closed via `validUntil =
 *     newFact.validFrom`, `status = superseded`. The two facts then sit on a
 *     sequenced timeline: an asOf-query within the prior interval returns the
 *     prior; an asOf-query within the new interval returns the new. This is
 *     the SQL:2011 FOR PORTION OF semantic and what Wikidata, XTDB and
 *     Graphiti all implement for state predicates (address, status, tier,
 *     brand_voice, ...). Future-dated facts are first-class: a new fact with
 *     validFrom > now schedules the transition and the prior's validUntil is
 *     set to that future date.
 *
 *   - `append_only` — non-functional (history matters), event- or
 *     preference-shaped. Multiple facts coexist. No conflict possible at
 *     ingest; the resolver picks at READ time via decayHalfLifeDays applied
 *     against the predicate's age. Used for behavioral history (preference,
 *     intent), complaints, registered events, and content-domain multi-valued
 *     fields (target_audience_segment, content_guideline, …).
 *
 *   - `bitemporal` — non-functional but cosine-similar facts may compete.
 *     If a new fact overlaps in valid-time AND is similar in object
 *     embedding (≥ similarity_threshold), it's scored against the prior and
 *     either supersedes (score gap > margin) or competes (both stay active
 *     with status='competing'). Allen's overlap predicate gates the
 *     comparison so sequential intervals don't trigger conflicts.
 *     Distinct from `single_active`: `bitemporal` admits NON-overlapping
 *     same-predicate facts; `single_active` doesn't.
 *
 * decayHalfLifeDays is the orthogonal axis — READ-time relevance decay, not
 * the on-ingest conflict policy. A `single_active` predicate can still have a
 * half-life: it affects how confidently the resolver picks the live value
 * when scoring competitors, but does NOT change the auto-close behavior.
 */

import { CORE_PREDICATES } from '../ai/predicate-registry.service';

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';

export interface PredicatePolicy {
  semantics: Semantics;
  decayHalfLifeDays: number | null; // null = never decay
  piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
  requiresScope?: 'brain:read_pii';
}

export const DEFAULT_POLICY: PredicatePolicy = {
  semantics: 'bitemporal',
  decayHalfLifeDays: 60,
  piiClass: 'none',
};

/**
 * Legacy non-tenant-aware policy lookup, kept for display-only consumers
 * (search result enrichment, artifact rendering, admin UI). The runtime
 * source of truth is the per-tenant `knowledge_predicate` registry via
 * PredicateRegistryService. This function falls back to the JS seed
 * (CORE_PREDICATES) so consumers that don't have a companyId in hand
 * still get sane defaults — they just won't see tenant-added predicates.
 *
 * Hot ingest / extraction paths SHOULD use PredicateRegistryService
 * .policyFor(companyId, predicate) instead.
 */
export function policyFor(predicate: string): PredicatePolicy {
  const seed = CORE_PREDICATES.find((p) => p.predicateId === predicate);
  if (!seed) return DEFAULT_POLICY;
  return {
    semantics: seed.semantics,
    decayHalfLifeDays: seed.decayHalfLifeDays,
    piiClass: seed.piiClass,
    ...(seed.requiresScope
      ? { requiresScope: seed.requiresScope as 'brain:read_pii' }
      : {}),
  };
}

/**
 * Re-exported alias of the JS seed table for legacy consumers (e.g.
 * entities.service that iterates known predicates for display). The
 * canonical, tenant-aware list comes from
 * PredicateRegistryService.getSnapshot().
 */
export const PREDICATE_POLICIES: Record<string, PredicatePolicy> =
  Object.fromEntries(
    CORE_PREDICATES.map((p) => [
      p.predicateId,
      {
        semantics: p.semantics,
        decayHalfLifeDays: p.decayHalfLifeDays,
        piiClass: p.piiClass,
        ...(p.requiresScope
          ? { requiresScope: p.requiresScope as 'brain:read_pii' }
          : {}),
      } as PredicatePolicy,
    ]),
  );

// ── Conflict resolution weights ──────────────────────────────────────────
// Mirror of conflict_resolution.scoring in the spec. Tunable via env.
export interface ConflictConfig {
  similarityThreshold: number;
  weights: {
    confidence: number;
    sourceTrust: number;
    recency: number;
    authority: number;
  };
  marginForSupersede: number;
  rejectThreshold: number;
}

export const SOURCE_TRUST: Record<string, number> = {
  human_declared:           1.00,
  billing_event:            0.95,
  incidents_event:          0.90,
  auth_event:               0.90,
  inbox_assistant_message:  0.70,
  inbox_human_message:      0.65,
  inbox_extraction:         0.50,
  voice_transcript:         0.40,
  external_webhook:         0.50,
  default:                  0.50,
};

export function recencyWeight(recordedAt: Date, now: Date = new Date()): number {
  const ageDays = (now.getTime() - recordedAt.getTime()) / (1000 * 60 * 60 * 24);
  // Exponential decay over 365d. Tunable via predicate-level half-life downstream.
  return Math.exp(-ageDays / 365);
}

export interface FactScoreInput {
  confidence: number;
  sourceTrust: number;
  recordedAt: Date;
  authority: number; // 0..1, set to 1.0 if caller flagged human_override
}

export function scoreFact(f: FactScoreInput, cfg: ConflictConfig): number {
  return (
    cfg.weights.confidence  * f.confidence +
    cfg.weights.sourceTrust * f.sourceTrust +
    cfg.weights.recency     * recencyWeight(f.recordedAt) +
    cfg.weights.authority   * f.authority
  );
}
