/**
 * Conflict resolution scoring per inite-ecosystem/core/capabilities/knowledge.yaml
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

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';

export interface PredicatePolicy {
  semantics: Semantics;
  decayHalfLifeDays: number | null; // null = never decay
  piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
  requiresScope?: 'brain:read_pii';
}

export const PREDICATE_POLICIES: Record<string, PredicatePolicy> = {
  // ── EVENT / utterance (append_only — history matters, no overlap) ──
  said:             { semantics: 'append_only',  decayHalfLifeDays: 30,   piiClass: 'text' },

  // ── IDENTITY (single_active — functional, lifetime-stable) ──
  name:             { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  email:            { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  phone:            { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  dob:              { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'sensitive', requiresScope: 'brain:read_pii' },

  // ── SINGLE-STATE (single_active — functional, time-varying). On a new
  //    overlapping fact, fn::resolve_fact auto-closes the prior via
  //    validUntil = newFact.validFrom (SQL:2011 sequenced semantic). Future-
  //    dated facts schedule the transition cleanly. This is what makes
  //    "address was Berlin in Feb, Dublin from July" work — both facts
  //    coexist on the timeline, asOf picks the right one. ──
  status:           { semantics: 'single_active', decayHalfLifeDays: 7,    piiClass: 'none' },
  tier:             { semantics: 'single_active', decayHalfLifeDays: 30,   piiClass: 'none' },
  address:          { semantics: 'single_active', decayHalfLifeDays: 90,   piiClass: 'sensitive', requiresScope: 'brain:read_pii' },

  // ── BEHAVIORAL history (append_only — non-functional, decay-weighted).
  //    Multiple facts coexist; read-time picks the live value by
  //    recency × decayHalfLifeDays. Don't auto-close — taste evolution and
  //    plan histories are valuable signal. ──
  intent:           { semantics: 'append_only',  decayHalfLifeDays: 60,   piiClass: 'behavioral' },
  preference:       { semantics: 'append_only',  decayHalfLifeDays: 90,   piiClass: 'behavioral' },
  complained_about: { semantics: 'append_only',  decayHalfLifeDays: 90,   piiClass: 'text' },
  interacted_with:  { semantics: 'append_only',  decayHalfLifeDays: 30,   piiClass: 'behavioral' },

  // Content-domain predicates (v1.1)
  // Singletons: only one canonical value per entity at a time; newer validFrom supersedes older.
  brand_voice:             { semantics: 'single_active', decayHalfLifeDays: 180,  piiClass: 'none' },
  brand_archetype:         { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'none' },
  tone_of_voice:           { semantics: 'single_active', decayHalfLifeDays: 180,  piiClass: 'none' },
  product_description:     { semantics: 'single_active', decayHalfLifeDays: 180,  piiClass: 'none' },
  // Multi-valued: each fact accumulates; no supersede occurs.
  target_audience_segment: { semantics: 'append_only',   decayHalfLifeDays: 90,   piiClass: 'none' },
  content_guideline:       { semantics: 'append_only',   decayHalfLifeDays: 365,  piiClass: 'none' },
  tension_point:           { semantics: 'append_only',   decayHalfLifeDays: 90,   piiClass: 'none' },
  reference_example:       { semantics: 'append_only',   decayHalfLifeDays: null, piiClass: 'none' },
  narrative_pillar:        { semantics: 'append_only',   decayHalfLifeDays: 365,  piiClass: 'none' },
  forbidden_pattern:       { semantics: 'append_only',   decayHalfLifeDays: null, piiClass: 'none' },
};

export const DEFAULT_POLICY: PredicatePolicy = {
  semantics: 'bitemporal',
  decayHalfLifeDays: 60,
  piiClass: 'none',
};

export function policyFor(predicate: string): PredicatePolicy {
  return PREDICATE_POLICIES[predicate] ?? DEFAULT_POLICY;
}

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
