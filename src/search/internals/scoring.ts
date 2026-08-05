import { policyFor } from '../../ingest/conflict-resolver';
import type { FusedRow, ScoredRow, EntityBucket } from './types';
import { diversityKey } from './diversity-key';

// Low-value "chatter" predicates. `said` is the extractor's residual class
// (a bare attributed utterance — "Hey Mel!", "That's great!") and, in a long
// conversation, floods an entity with hundreds of contentless facts.
// They compete at full strength for the few per-entity slots that reach
// synthesis and bury the substantive facts (preference/intent/status). The chatterPenalty (SEARCH_CHATTER_PENALTY,
// default 1.0 = off) is a sub-1.0 multiplier that demotes them below real
// facts of the same entity. Kept a set (not the α map) because it's a
// PENALTY, structurally distinct from the boost that can't go below 1.
const CHATTER_PREDICATES = new Set(['said']);

const DEGREE_BOOST_WEIGHT = 0.3;
const DEGREE_BOOST_TOP_N = 2;

/**
 * Optional confidence calibrator — fits the Phase 3 isotonic-
 * regression map at boot and rewrites every raw confidence on its way
 * into the final score. Passed in to keep `scoreRows` pure / unit-
 * testable. When `null`, raw confidence is used unchanged.
 */
export interface ConfidenceCalibrator {
  calibrate(rawConfidence: number): number;
}

/**
 * Decay × calibratedConfidence scoring for each fused row. Pure —
 * `now` and `calibrator` are passed in so tests stay deterministic.
 *
 *   score = fusedScore × exp(-ln2 × ageDays / halfLife)
 *           × calibratedConfidence
 *
 * `policy.decayHalfLifeDays` null → no decay (1.0). `calibrator` null →
 * calibratedConfidence === rawConfidence.
 */
export interface ScoreRowsOptions {
  rows: FusedRow[];
  now: number;
  calibrator?: ConfidenceCalibrator | null;
  /**
   * Source-reputation track, Phase 5 — read-time fact_trust. β scales the
   * write-time source-reputation snapshot into ranking
   * (`× (1 + β·(trust − 0.5))`), γ scales cross-source corroboration
   * (`× (1 + γ·min(count, 3))`). Both default 0 → factors exactly 1.0 →
   * byte-identical ranking; facts without a snapshot sit on the neutral
   * 0.5, so they are unaffected at ANY β.
   */
  trustBeta?: number;
  corroborationGamma?: number;
  /**
   * δ scales the registry-declared source authority (0..1, stamped into
   * trustSnapshot at write time) into ranking (`× (1 + δ·authority)`).
   * Unlike trust, authority has no neutral midpoint — 0 means "no declared
   * authority", so facts without a registry entry are unaffected at ANY δ.
   * Default 0 → factor exactly 1.0 → byte-identical ranking.
   */
  authorityDelta?: number;
  /**
   * Sub-1.0 multiplier applied to CHATTER_PREDICATES (`said`) facts to
   * demote contentless conversational utterances below substantive facts
   * of the same entity. Default 1.0 → no penalty → byte-identical ranking.
   * Only values in (0,1] make sense; ≥1 (or unset) leaves chatter unpenalized.
   */
  chatterPenalty?: number;
}

const CORROBORATION_CAP = 3;

export function scoreRows({
  rows,
  now,
  calibrator = null,
  trustBeta = 0,
  corroborationGamma = 0,
  authorityDelta = 0,
  chatterPenalty = 1,
}: ScoreRowsOptions): ScoredRow[] {
  // A penalty is only meaningful in (0,1]; anything else (unset, ≥1, invalid)
  // means "no penalty" so ranking is byte-identical to before.
  const chatterFactorFor = (predicate: string): number =>
    chatterPenalty > 0 && chatterPenalty < 1 && CHATTER_PREDICATES.has(predicate)
      ? chatterPenalty
      : 1;
  return rows.map((row) => {
    const policy = policyFor(row.predicate);
    // Usage reinforcement: when the pipeline attached a lastReadAt
    // (SEARCH_USAGE_DECAY_ENABLED → enrichWithUsage), the decay clock
    // restarts at the most recent retrieval — memory that keeps getting
    // used stays fresh. Unenriched rows decay from recordedAt exactly
    // as before, so the flag off is byte-identical.
    const freshAnchor = row.lastReadAt
      ? Math.max(
          new Date(row.recordedAt).getTime(),
          new Date(row.lastReadAt).getTime(),
        )
      : new Date(row.recordedAt).getTime();
    const ageDays = (now - freshAnchor) / 86_400_000;
    const decay =
      policy.decayHalfLifeDays === null
        ? 1
        : Math.exp((-Math.LN2 * ageDays) / policy.decayHalfLifeDays);
    const calibratedConfidence = calibrator
      ? calibrator.calibrate(row.confidence)
      : row.confidence;

    // fact_trust (Phase 5): the write-time snapshot ladder. Multiplicative
    // ranking semantics, kept OUT of the resolver's weighted sum — see the
    // source-reputation track design.
    //
    // fn::resolve_fact ALWAYS stamps learnedTrust — including the neutral
    // 0.5 fallback when the source has <8 samples — so a bare
    // `learned ?? declared` would shadow the declared tier heuristic
    // forever. A learned value of EXACTLY 0.5 is indistinguishable from
    // (and ranking-equivalent to) "no signal" (β·(0.5−0.5) = 0), so it
    // defers to the declared tier; any other learned value wins.
    const snapshot = row.trustSnapshot ?? null;
    const learned =
      snapshot?.learnedTrust !== undefined && snapshot.learnedTrust !== 0.5
        ? snapshot.learnedTrust
        : undefined;
    const sourceReputation = learned ?? snapshot?.declaredTrust ?? 0.5;
    const corroborationCount = row.corroboration?.count ?? 0;
    const authority = snapshot?.authority ?? 0;
    const trustFactor = 1 + trustBeta * (sourceReputation - 0.5);
    const corroborationFactor =
      1 + corroborationGamma * Math.min(corroborationCount, CORROBORATION_CAP);
    const authorityFactor = 1 + authorityDelta * authority;
    const factTrust = {
      sourceReputation,
      authority,
      corroborationCount,
      evidenceCount: Array.isArray(row.source?.evidence)
        ? row.source.evidence.length
        : 0,
      trustFactor,
      corroborationFactor,
      authorityFactor,
    };

    const chatterFactor = chatterFactorFor(row.predicate);
    const finalScore =
      row.fusedScore *
      decay *
      calibratedConfidence *
      chatterFactor *
      trustFactor *
      corroborationFactor *
      authorityFactor;
    return {
      row,
      score: finalScore,
      breakdown: {
        fusedScore: row.fusedScore,
        confidence: row.confidence,
        calibratedConfidence,
        decay,
        ...(chatterFactor !== 1 ? { chatterPenalty: chatterFactor } : {}),
        factTrust,
        finalScore,
        stages: row.stages ?? [],
      },
    };
  });
}

/**
 * Group scored rows by entity and compute the diversity-aware degree
 * boost. Per-entity ranking score is best-fact-score plus a bounded
 * contribution from additional matched facts — only the best fact per
 * (predicate, normalized-3-token-prefix) tuple counts. Prevents an
 * entity with five near-duplicate `complained_about` facts from
 * accumulating a boost five times for one piece of evidence.
 *
 * Pure — no IO. Returns the map for the next stage (edge expansion,
 * PPR, rerank).
 */
export function bucketByEntity(scored: ScoredRow[]): Map<string, EntityBucket> {
  const byEntity = new Map<string, EntityBucket>();
  for (const sf of scored) {
    const eid = String(sf.row.entityId);
    const bucket: EntityBucket =
      byEntity.get(eid) ??
      ({ entityId: eid, rankScore: 0, bestScore: 0, facts: [] } as EntityBucket);
    bucket.facts.push(sf);
    if (sf.score > bucket.bestScore) bucket.bestScore = sf.score;
    byEntity.set(eid, bucket);
  }
  for (const bucket of byEntity.values()) {
    const sortedFacts = [...bucket.facts].sort((a, b) => b.score - a.score);
    const seenKeys = new Set<string>();
    const supplementary: number[] = [];
    // Skip exactly ONE best-scoring fact — it's already represented by
    // bestScore. A boolean flag (not `supplementary.length === 0`) is
    // required: with ≥2 facts tied at bestScore, the length check stays 0
    // until a non-best fact is pushed, so every tied-best fact was wrongly
    // skipped and never contributed to the degree boost.
    let skippedBest = false;
    for (const f of sortedFacts) {
      const key = diversityKey(f.row.predicate, f.row.object);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (f.score === bucket.bestScore && !skippedBest) {
        skippedBest = true;
        continue;
      }
      supplementary.push(f.score);
      if (supplementary.length >= DEGREE_BOOST_TOP_N) break;
    }
    const boost = supplementary.reduce((acc, s) => acc + s, 0);
    bucket.rankScore = bucket.bestScore + DEGREE_BOOST_WEIGHT * boost;
  }
  return byEntity;
}
