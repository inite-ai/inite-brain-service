/**
 * Conflict resolution scoring per inite-ecosystem/core/capabilities/knowledge.yaml
 *
 * Predicate semantics:
 *   - append_only:  every fact stays active. No conflicts possible.
 *   - single_active: latest active wins. New supersedes old without scoring.
 *   - bitemporal:   new facts compete via weighted score; ties leave both active.
 */

export type Semantics = 'append_only' | 'single_active' | 'bitemporal';

export interface PredicatePolicy {
  semantics: Semantics;
  decayHalfLifeDays: number | null; // null = never decay
  piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
  requiresScope?: 'brain:read_pii';
}

export const PREDICATE_POLICIES: Record<string, PredicatePolicy> = {
  said:             { semantics: 'append_only',  decayHalfLifeDays: 30,   piiClass: 'text' },
  name:             { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  email:            { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  phone:            { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'identifier' },
  status:           { semantics: 'bitemporal',   decayHalfLifeDays: 7,    piiClass: 'none' },
  tier:             { semantics: 'bitemporal',   decayHalfLifeDays: 30,   piiClass: 'none' },
  intent:           { semantics: 'bitemporal',   decayHalfLifeDays: 60,   piiClass: 'behavioral' },
  preference:       { semantics: 'bitemporal',   decayHalfLifeDays: 90,   piiClass: 'behavioral' },
  complained_about: { semantics: 'append_only',  decayHalfLifeDays: 90,   piiClass: 'text' },
  interacted_with:  { semantics: 'append_only',  decayHalfLifeDays: 30,   piiClass: 'behavioral' },
  address:          { semantics: 'bitemporal',   decayHalfLifeDays: 90,   piiClass: 'sensitive', requiresScope: 'brain:read_pii' },
  dob:              { semantics: 'single_active', decayHalfLifeDays: null, piiClass: 'sensitive', requiresScope: 'brain:read_pii' },

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
