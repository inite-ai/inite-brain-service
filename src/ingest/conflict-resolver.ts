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
import type { EvidenceCapability } from '../synthesize/synthesize.types';

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';

/**
 * V9 §1: the derive-internal semantics superset. 'bitemporal_event'
 * (migration 0083 — bitemporal gating with event-time recency and
 * later-validFrom-wins supersede) is deliberately NOT part of the
 * public `Semantics` union: it is never a predicate policy, never
 * accepted by the registry admin API, and never appears in the wire
 * schemas — only the derived-batch write path emits it. Typing it as
 * a separate union keeps the registry surface closed while giving the
 * write path a compile-time name for the value (a bare-string typo
 * would silently take the fn's gated ELSE branch).
 */
export type DerivedSemantics = Semantics | 'bitemporal_event';

/**
 * One row's result from fn::resolve_fact / fn::resolve_facts, as the
 * TS side consumes it. The stored fn returns additional per-outcome
 * fields (supersededFactIds, scoreBreakdown, …) — modeled loosely via
 * the index signature; the discriminant and factId are the contract
 * every caller relies on. 'SKIPPED' is TS-side only: the V9 phase-0
 * fence emits it for a row whose per-row retry also failed.
 */
export interface ResolveOutcome {
  outcome:
    | 'INSERTED'
    | 'INSERTED_HISTORICAL'
    | 'SUPERSEDED'
    | 'COMPETING'
    | 'CORROBORATED'
    | 'REJECTED'
    | 'SKIPPED';
  factId: string | null;
  reason?: string | null;
  [extra: string]: unknown;
}

export interface PredicatePolicy {
  semantics: Semantics;
  decayHalfLifeDays: number | null; // null = never decay
  piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
  requiresScope?: 'brain:read_pii';
  /**
   * 0113 (FOVEA_EVIDENCE_CAPABILITY): the evidence capability claims
   * under this predicate REQUIRE to verify. Absent = 'text' =
   * unconstrained — every CORE seed predicate carries no value (all
   * text); only tenant registry rows (knowledge_predicate column) set
   * it. Consumed by the verdict-side evidence-capability gate.
   */
  requiredEvidenceCapability?: EvidenceCapability;
}

export const DEFAULT_POLICY: PredicatePolicy = {
  // W3 (audit 2026-08 #2): unknown predicate = open-vocabulary coinage →
  // append_only, mirroring DEFAULT_FALLBACK in the tenant registry
  // (predicate-registry-internals/types.ts) so display-only consumers
  // report the same semantics the write path applies.
  semantics: 'append_only',
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
    ...(seed.requiresScope ? { requiresScope: seed.requiresScope as 'brain:read_pii' } : {}),
    // 0113: no CORE seed sets it (all text) — threaded for shape parity
    // with the registry rows so a future seed value is not silently lost.
    ...(seed.requiredEvidenceCapability
      ? { requiredEvidenceCapability: seed.requiredEvidenceCapability }
      : {}),
  };
}

/**
 * Re-exported alias of the JS seed table for legacy consumers (e.g.
 * entities.service that iterates known predicates for display). The
 * canonical, tenant-aware list comes from
 * PredicateRegistryService.getSnapshot().
 */
export const PREDICATE_POLICIES: Record<string, PredicatePolicy> = Object.fromEntries(
  CORE_PREDICATES.map((p) => [
    p.predicateId,
    {
      semantics: p.semantics,
      decayHalfLifeDays: p.decayHalfLifeDays,
      piiClass: p.piiClass,
      ...(p.requiresScope ? { requiresScope: p.requiresScope as 'brain:read_pii' } : {}),
      ...(p.requiredEvidenceCapability
        ? { requiredEvidenceCapability: p.requiredEvidenceCapability }
        : {}),
    } as PredicatePolicy,
  ]),
);

// ── Conflict resolution weights ──────────────────────────────────────────
// Mirror of conflict_resolution.scoring in the spec. Tunable via env.
export interface ConflictConfig {
  similarityThreshold: number;
  /**
   * V10 §1: the bitemporal_event competing pool's own cosine gate
   * (DERIVER_SLOT_SIMILARITY). The shared threshold is tuned for live
   * ingest and measured clustering whole topics on dev-chat derive
   * (v9lifecycle); the slot gate tightens derive-only without touching
   * 'bitemporal' behavior.
   */
  slotSimilarityThreshold: number;
  weights: {
    confidence: number;
    sourceTrust: number;
    recency: number;
    authority: number;
  };
  marginForSupersede: number;
  rejectThreshold: number;
}

// `satisfies` (not a `Record<string, number>` annotation) so each key keeps
// its concrete presence: static property access (SOURCE_TRUST.billing_event)
// stays `number` under noUncheckedIndexedAccess. Never indexed by a dynamic
// key — every read is a literal member.
export const SOURCE_TRUST = {
  human_declared: 1.0,
  billing_event: 0.95,
  incidents_event: 0.9,
  auth_event: 0.9,
  inbox_assistant_message: 0.7,
  inbox_human_message: 0.65,
  inbox_extraction: 0.5,
  voice_transcript: 0.4,
  external_webhook: 0.5,
  default: 0.5,
} satisfies Record<string, number>;

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
    cfg.weights.confidence * f.confidence +
    cfg.weights.sourceTrust * f.sourceTrust +
    cfg.weights.recency * recencyWeight(f.recordedAt) +
    cfg.weights.authority * f.authority
  );
}
