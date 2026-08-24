/**
 * Fovea optics — the focus signal (Optics-1 foundation).
 *
 * Companion to docs/roadmap/fovea-optics-2026-08.md §2-§4.2. The fovea
 * cascade decides WHERE to spend high resolution (L3 escalation, the
 * abstention floor, lens suppression). Today those decisions read a
 * static constant. The researched plan makes them adaptive — but §3 is
 * emphatic that adaptive allocation AMPLIFIES a bad signal, so the honest
 * prerequisite is not any adaptive decision: it is a SINGLE per-query-class
 * calibrated confidence signal whose trustworthiness is measured (ECE /
 * reliability diagram) BEFORE anything consumes it.
 *
 * This module is that foundation, and nothing else:
 *   - `FocusSignal` — the signal's definition (the three inputs §2 names:
 *     verifier verdict, evidence coverage, retrieval score distribution).
 *   - `rawFocusConfidence` — a documented, monotone blend → [0,1]. This is
 *     the RAW signal; calibration corrects it.
 *   - `queryClassOf` — LaneId → calibration class (encodes the genre law:
 *     a lane that is +LoCoMo is −28pp on assistant-chats, so a single
 *     global threshold is miscalibrated across classes).
 *   - `fitPerClass` / `calibratedConfidence` — per-class isotonic
 *     calibration, REUSING the in-repo PAV primitive (isotonic.ts). No new
 *     PAV; no parallel calibration mechanism.
 *   - `computeReliability` — the §3 measurement (ECE + reliability-diagram
 *     bins, global and per-class).
 *
 * Pure module — no DI, no IO, no env. Persistence + capture live in
 * focus-signal.service.ts; the decision-point wiring is one guarded call
 * in synthesize.service.ts. SERVING-NEUTRAL: nothing here is consumed by
 * the serving path yet (Optics-2/3 wire depth / threshold / suppression).
 */

import {
  applyMap,
  fitIsotonic,
  type CalibrationMap,
  type CalibrationPair,
} from '../ai/calibration/isotonic';
import type { LaneId } from './answer-router';

/** The verifier verdict, extended with 'none' for the paths where no
 *  verifier ran (off/answer modes, pre-verifier abstention exits). */
export type FocusVerdict = 'supported' | 'partial' | 'unsupported' | 'none';

/**
 * Capture/calibration stage — the population a sample (and the calibrator
 * fit from it) belongs to. fit-shape MUST equal apply-shape, so the two are
 * never pooled (docs/roadmap/fovea-optics-2026-08.md §4.2):
 *   - 'verdict'   — captured at the synthesize verdict point WITH a real
 *     verifier verdict (Optics-1 capture, Optics-2 L3 consume).
 *   - 'preanswer' — captured at the pre-generation coverage-abstention gate,
 *     where no verifier has run yet, so verifierVerdict is a CONSTANT 'none'
 *     (Optics §4.2 capture + consume). The constant offset is absorbed by
 *     the isotonic fit; mixing the two populations would miscalibrate both.
 *
 * A stored row with stage=NONE is read as 'verdict' — the only population
 * that existed before the stage column (migration 0095).
 */
export type FocusStage = 'preanswer' | 'verdict';

/**
 * The focus signal at the verdict/abstention decision point — the three
 * inputs §2 identifies, plus the query class that keys calibration.
 */
export interface FocusSignal {
  /** Calibration class (see `queryClassOf`) — the routed LaneId, or
   *  'default' for unrouted queries. */
  queryClass: string;
  /** Best (top-1) per-fact retrieval score across the evidence, in [0,1].
   *  The abstention floor's `minTopScore` reads the same value. */
  topScore: number;
  /** Mean per-fact retrieval score across the retained evidence, in [0,1]
   *  — how strongly, on average, the evidence matches the question. The
   *  §3 "coverage_score" whose calibration this module measures. */
  coverageScore: number;
  /** The verifier's grounding verdict, or 'none' when no verifier ran. */
  verifierVerdict: FocusVerdict;
  /** top1 − topN: the spread of the retained score distribution. A wide
   *  gap means the top hit stands out (a distinctive, confident retrieval);
   *  a flat distribution (small gap) means ambiguous evidence. In [0,1]. */
  retrievalGap: number;
}

/** A captured signal paired with its observed outcome (1 = the answer was
 *  correct, 0 = incorrect). The outcome is unknown at serving time — it is
 *  backfilled by the eval harness — so calibration/measurement operate on
 *  labeled samples only. */
export type FocusOutcomeSample = FocusSignal & { correct: 0 | 1 };

/** Per-query-class calibration: one PAV map per class, plus a shared
 *  'default' map used for unrouted queries and as the sparse-class
 *  fallback. */
export type PerClassCalibration = Record<string, CalibrationMap>;

/**
 * Minimum labeled samples a class needs before it earns its OWN calibration
 * map. Below this a class falls back to the shared 'default' map (fit over
 * every sample) — a per-class isotonic fit on a handful of points overfits
 * and is worse than the pooled prior. 30 mirrors the ~100-200/class the
 * roadmap targets while still admitting sparse lanes to the fallback rather
 * than dropping them. (The nightly fact-calibration refit uses a 40-pair
 * global floor; this is the per-class analogue.)
 */
export const MIN_CLASS_SAMPLES = 30;

/** The shared/fallback calibration-class key. */
export const DEFAULT_CLASS = 'default';

// ── Raw signal ─────────────────────────────────────────────────────

/**
 * Verdict → a numeric score in [0,1]. supported (fully grounded) is the
 * strongest positive evidence; partial is a half-signal; unsupported and
 * 'none' (no verdict available) both contribute nothing.
 */
function verdictScore(v: FocusVerdict): number {
  switch (v) {
    case 'supported':
      return 1;
    case 'partial':
      return 0.5;
    default:
      return 0; // 'unsupported' | 'none'
  }
}

// Blend weights — documented, and deliberately simple. Every term is a
// POSITIVE contribution, so `rawFocusConfidence` is monotone-nondecreasing
// in each input (the property the calibrator and the reliability
// measurement both assume). Coverage and verdict carry the most weight
// (they are the two signals §2 leans on); topScore and the distribution
// gap are refinements. Sum = 1, so the output stays in [0,1].
const W_COVERAGE = 0.35;
const W_VERDICT = 0.35;
const W_GAP = 0.15;
const W_TOP = 0.15;

/**
 * The RAW focus confidence in [0,1] — a documented, monotone blend of the
 * four inputs. This is deliberately crude: it is the signal calibration
 * CORRECTS. Its job is only to be monotone-ish and cheap; `fitPerClass`
 * learns the actual raw→P(correct) shape per class.
 */
export function rawFocusConfidence(sig: FocusSignal): number {
  const cov = clamp01(sig.coverageScore);
  const top = clamp01(sig.topScore);
  const gap = clamp01(sig.retrievalGap);
  const verdict = verdictScore(sig.verifierVerdict);
  return clamp01(W_COVERAGE * cov + W_VERDICT * verdict + W_GAP * gap + W_TOP * top);
}

/**
 * Build a `FocusSignal` from a bag of per-fact retrieval scores plus the
 * verdict and class. Pure — the service flattens `SearchHit[]` into scores
 * and calls this, so the arithmetic stays unit-testable without domain
 * types. `factScores` need not be sorted.
 */
export function buildFocusSignal(input: {
  queryClass: string;
  factScores: readonly number[];
  verifierVerdict: FocusVerdict;
}): FocusSignal {
  const scores = input.factScores.filter((s) => Number.isFinite(s)).map(clamp01);
  if (scores.length === 0) {
    return {
      queryClass: input.queryClass,
      topScore: 0,
      coverageScore: 0,
      verifierVerdict: input.verifierVerdict,
      retrievalGap: 0,
    };
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const topScore = sorted[0]!;
  const lastScore = sorted[sorted.length - 1]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    queryClass: input.queryClass,
    topScore,
    coverageScore: clamp01(mean),
    verifierVerdict: input.verifierVerdict,
    retrievalGap: clamp01(topScore - lastScore),
  };
}

/**
 * LaneId → calibration class. Unrouted queries (null) map to 'default'.
 * One class per lane by design: the segment-lane genre law says a lane's
 * value flips sign across genres, so its calibration must be per-class.
 */
export function queryClassOf(laneId: LaneId | null | undefined): string {
  return laneId ?? DEFAULT_CLASS;
}

// ── Per-class calibration (reuses isotonic.ts) ─────────────────────

/**
 * Fit one isotonic calibration map per query-class from labeled samples,
 * mapping rawFocusConfidence → P(correct). Grouping is by `queryClass`.
 *
 *   - A shared 'default' map is ALWAYS fit over EVERY sample. It is both
 *     the map for unrouted ('default') queries and the fallback for any
 *     class below MIN_CLASS_SAMPLES.
 *   - Each class with ≥ MIN_CLASS_SAMPLES labeled samples earns its own
 *     map, fit on its samples alone.
 *   - Sparse classes get no own map — `calibratedConfidence` falls through
 *     to 'default'. A missed per-class fit therefore degrades to the pooled
 *     prior, never to nothing.
 *
 * Reuses `fitIsotonic` (the PAV primitive) throughout — no new regression.
 */
export function fitPerClass(samples: readonly FocusOutcomeSample[]): PerClassCalibration {
  const byClass = new Map<string, CalibrationPair[]>();
  const all: CalibrationPair[] = [];
  for (const s of samples) {
    const pair: CalibrationPair = {
      rawConfidence: rawFocusConfidence(s),
      correctness: s.correct,
    };
    all.push(pair);
    const bucket = byClass.get(s.queryClass);
    if (bucket) bucket.push(pair);
    else byClass.set(s.queryClass, [pair]);
  }
  const out: PerClassCalibration = { [DEFAULT_CLASS]: fitIsotonic(all) };
  for (const [cls, pairs] of byClass) {
    if (cls === DEFAULT_CLASS) continue; // the shared map already covers it
    if (pairs.length >= MIN_CLASS_SAMPLES) out[cls] = fitIsotonic(pairs);
  }
  return out;
}

/**
 * Apply the calibrated map for a signal's class to its raw confidence.
 * Uses the class's own map when present, else the shared 'default' map,
 * else (empty calibration) the raw value unchanged.
 */
export function calibratedConfidence(cal: PerClassCalibration, sig: FocusSignal): number {
  const raw = rawFocusConfidence(sig);
  const map = cal[sig.queryClass] ?? cal[DEFAULT_CLASS];
  return map ? applyMap(map, raw) : raw;
}

/**
 * Whether a loaded calibration is a USABLE model — the Optics-2 gate (§4.1)
 * that decides adaptive-vs-static. A model is usable only if at least one
 * class map was fit from real labeled samples (sampleCount > 0). This is
 * the load-bearing safety predicate: an EMPTY map ({} — nothing persisted)
 * and a BOOTSTRAP map (fitIsotonic over zero pairs → sampleCount 0) both
 * return false, so an unconfigured or freshly-bootstrapped tenant falls
 * back to the static coverage path and serves byte-identically to today.
 */
export function hasUsableCalibration(cal: PerClassCalibration): boolean {
  return Object.values(cal).some((m) => m.sampleCount > 0);
}

// ── §3 measurement: reliability diagram + ECE ──────────────────────

export interface ReliabilityBin {
  /** Lower edge of the bin on the predicted-probability axis. */
  binLo: number;
  /** Upper edge of the bin. */
  binHi: number;
  /** Mean predicted probability of the samples in the bin (bin center when
   *  empty — a plotting placeholder that contributes 0 to ECE). */
  meanPred: number;
  /** Observed correctness fraction of the samples in the bin (0 when
   *  empty). */
  empirical: number;
  /** Number of samples in the bin. */
  count: number;
}

export interface ReliabilityReport {
  /** Global expected calibration error over all samples, in [0,1]. */
  ece: number;
  /** ECE computed independently per query-class. */
  perClassEce: Record<string, number>;
  /** The global reliability diagram — one entry per bin. */
  diagram: ReliabilityBin[];
}

/**
 * The §3 measurement: bin the RAW focus confidence, compare mean predicted
 * vs observed correctness per bin, and report ECE + the reliability diagram
 * — globally and per query-class.
 *
 * ECE = Σ_bins (count_bin / N) · |meanPred_bin − empirical_bin|.
 *
 * Predicting with `rawFocusConfidence` (NOT a calibrated value) is
 * deliberate: this measures whether the RAW signal is trustworthy, which is
 * the gate §3 requires before any adaptive optic is wired. A low ECE means
 * adaptive gating will help; a high/miscalibrated-per-class ECE is itself
 * the finding — fix calibration (fitPerClass) first.
 */
export function computeReliability(
  samples: readonly FocusOutcomeSample[],
  bins = 10,
): ReliabilityReport {
  const global = reliabilityFor(samples, bins);
  const classes = new Set(samples.map((s) => s.queryClass));
  const perClassEce: Record<string, number> = {};
  for (const cls of classes) {
    perClassEce[cls] = reliabilityFor(
      samples.filter((s) => s.queryClass === cls),
      bins,
    ).ece;
  }
  return { ece: global.ece, perClassEce, diagram: global.diagram };
}

/** Global ECE + diagram over one sample set. */
function reliabilityFor(
  samples: readonly FocusOutcomeSample[],
  bins: number,
): { ece: number; diagram: ReliabilityBin[] } {
  const nBins = Math.max(1, Math.floor(bins));
  const predSum = new Array<number>(nBins).fill(0);
  const correctSum = new Array<number>(nBins).fill(0);
  const counts = new Array<number>(nBins).fill(0);
  for (const s of samples) {
    const p = rawFocusConfidence(s);
    let idx = Math.floor(p * nBins);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    predSum[idx]! += p;
    correctSum[idx]! += s.correct;
    counts[idx]! += 1;
  }
  const total = samples.length;
  const diagram: ReliabilityBin[] = [];
  let ece = 0;
  for (let i = 0; i < nBins; i++) {
    const binLo = i / nBins;
    const binHi = (i + 1) / nBins;
    const count = counts[i]!;
    if (count === 0) {
      diagram.push({ binLo, binHi, meanPred: (binLo + binHi) / 2, empirical: 0, count: 0 });
      continue;
    }
    const meanPred = predSum[i]! / count;
    const empirical = correctSum[i]! / count;
    diagram.push({ binLo, binHi, meanPred, empirical, count });
    ece += (count / total) * Math.abs(meanPred - empirical);
  }
  return { ece: total === 0 ? 0 : ece, diagram };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
