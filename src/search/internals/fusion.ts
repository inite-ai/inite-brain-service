import type { SearchMode } from '../dto/search.dto';
import type { FactRow, FusedRow } from './types';

// Convex combination weight for hybrid fusion. 0.5 = equal trust in
// vector and lexical legs. We deliberately avoid pure rank-based RRF
// (Cormack et al. 2009) — measured: recall@1 0.85 (convex) → 0.43
// (RRF k=60) on the quality eval. For our small per-tenant scale
// (hundreds of facts), ranks are too coarse — a perfect cosine match
// (≈1.0) and a weak match (≈0.05) both end up at rank 1 if no better
// candidate exists, and RRF treats them as equivalent.
//
// CombMNZ consensus boost was also tested (×1.3 when both legs hit) —
// no measurable improvement (median 0.82 vs 0.84 baseline). Most
// queries are dominated by a single leg; boosting both-leg agreement
// occasionally promotes consensus on noise. Reverted.
export const HYBRID_VECTOR_WEIGHT = 0.5;

/** Cosine in [-1, 1] → [0, 1] with negative-correlation clamped to 0. */
export function normalizeVec(s: number): number {
  return s <= 0 ? 0 : s > 1 ? 1 : s;
}

/**
 * Squash BM25 scores into [0, 1] via a saturation curve. BM25 is
 * unbounded (a 5-term match on a short doc can score 10+), so we
 * pass it through x/(1+x) to keep the lexical-only mode's final
 * score on the same scale as vector cosine.
 */
export function normalizeLex(s: number): number {
  return s <= 0 ? 0 : s / (1 + s);
}

/**
 * Score-level convex fusion. Each leg's raw score is normalised to
 * [0, 1] and the legs are combined linearly. Vector-only / lexical-
 * only modes short-circuit to single-leg normalisation.
 *
 * Returns a unified row list keyed by factId with `fusedScore`
 * attached for downstream scoring.
 */
export function fuse(
  vectorRows: FactRow[],
  lexicalRows: FactRow[],
  mode: SearchMode,
): FusedRow[] {
  const merged = new Map<string, FusedRow>();

  if (mode === 'vector') {
    for (const r of vectorRows) {
      merged.set(String(r.id), { ...r, fusedScore: normalizeVec(r.simScore ?? 0) });
    }
    return [...merged.values()];
  }

  if (mode === 'lexical') {
    for (const r of lexicalRows) {
      merged.set(String(r.id), { ...r, fusedScore: normalizeLex(r.bm25Score ?? 0) });
    }
    return [...merged.values()];
  }

  // hybrid — convex w·vec + (1-w)·lex; one leg can be zero.
  const w = HYBRID_VECTOR_WEIGHT;
  for (const r of vectorRows) {
    merged.set(String(r.id), {
      ...r,
      fusedScore: w * normalizeVec(r.simScore ?? 0),
    });
  }
  for (const r of lexicalRows) {
    const key = String(r.id);
    const prior = merged.get(key);
    if (prior) {
      prior.fusedScore += (1 - w) * normalizeLex(r.bm25Score ?? 0);
      prior.bm25Score = r.bm25Score;
    } else {
      merged.set(key, {
        ...r,
        fusedScore: (1 - w) * normalizeLex(r.bm25Score ?? 0),
      });
    }
  }
  return [...merged.values()];
}
