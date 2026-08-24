/**
 * Multilingual extraction F1 — set-overlap precision / recall / F1 over
 * a predicted vs gold fact set.
 *
 * The facts are LANGUAGE-NEUTRAL canonical keys (`predicate=value`, e.g.
 * `status=cfo`), so the same scorer works whether the source text was
 * Cyrillic, CJK, RTL or Latin: the extractor's job is to normalize the
 * surface form to the canonical fact, and F1 measures how well it did.
 *
 * Pure — no IO, no model calls. The matrix runner groups the per-case
 * scores by language before aggregating; this module just does the math.
 *
 * Edge-case convention (mirrors joint-f1.ts `setMetrics`):
 *   - both empty          → P=R=F1=1 (asked for nothing, delivered nothing)
 *   - predicted empty     → P=R=F1=0
 *   - gold empty (noise)  → P=0, R=1 (no false negatives possible), F1=0
 */

export interface PrecisionRecallF1 {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface ExtractionF1Aggregate {
  /** Micro-averaged over the pooled TP/FP/FN across all cases. */
  precision: number;
  recall: number;
  microF1: number;
  /** Macro-averaged — mean of per-case F1 (each case weighted equally). */
  macroF1: number;
  count: number;
}

export function extractionF1(predicted: string[], gold: string[]): PrecisionRecallF1 {
  const predSet = new Set(predicted);
  const goldSet = new Set(gold);

  if (predSet.size === 0 && goldSet.size === 0) {
    return {
      precision: 1,
      recall: 1,
      f1: 1,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
    };
  }

  let tp = 0;
  for (const p of predSet) if (goldSet.has(p)) tp++;
  const fp = predSet.size - tp;
  const fn = goldSet.size - tp;

  const precision = predSet.size === 0 ? 0 : tp / predSet.size;
  // Vacuous recall (1) when gold is empty — no false negatives are possible.
  const recall = goldSet.size === 0 ? 1 : tp / goldSet.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1, truePositives: tp, falsePositives: fp, falseNegatives: fn };
}

/** Micro + macro aggregate across a batch of per-case scores. null on empty. */
export function meanExtractionF1(scores: PrecisionRecallF1[]): ExtractionF1Aggregate | null {
  if (scores.length === 0) return null;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let f1Sum = 0;
  for (const s of scores) {
    tp += s.truePositives;
    fp += s.falsePositives;
    fn += s.falseNegatives;
    f1Sum += s.f1;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const microF1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, microF1, macroF1: f1Sum / scores.length, count: scores.length };
}
