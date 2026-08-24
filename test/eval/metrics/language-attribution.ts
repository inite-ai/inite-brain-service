/**
 * Language-attribution telemetry aggregator (Tier 0 — DEFINITION + scorer
 * only, no emission).
 *
 * Tier 1 will wire brain's ingest/query/answer paths to emit a
 * `LanguageAttributionSample` per detected-language decision (label +
 * confidence + source + detectorVersion). This aggregator is the target
 * shape those samples roll up into: per-language / per-source /
 * per-detector-version distributions, overall mean confidence, and the
 * share of low-confidence detections (the operator's "how much of our
 * traffic can't we identify" gauge).
 *
 * Pure — synthetic samples in, distribution report out. Nothing here
 * touches prod code; emission is deliberately out of Tier 0's scope.
 */

import type { LanguageAttributionSample, LanguageAttributionReport } from '../../../src/eval/types';

const DEFAULT_LOW_CONFIDENCE = 0.7;

function countBy<T>(
  samples: LanguageAttributionSample[],
  key: (s: LanguageAttributionSample) => T,
): Map<T, LanguageAttributionSample[]> {
  const out = new Map<T, LanguageAttributionSample[]>();
  for (const s of samples) {
    const k = key(s);
    out.set(k, [...(out.get(k) ?? []), s]);
  }
  return out;
}

export function aggregateLanguageAttribution(
  samples: LanguageAttributionSample[],
  lowConfidenceThreshold: number = DEFAULT_LOW_CONFIDENCE,
): LanguageAttributionReport {
  const total = samples.length;

  const byLanguage = [...countBy(samples, (s) => s.lang).entries()]
    .map(([lang, rows]) => ({
      lang,
      count: rows.length,
      meanConfidence: rows.reduce((a, s) => a + s.confidence, 0) / rows.length,
    }))
    // Deterministic order: most frequent first, ties broken by label.
    .sort((a, b) => b.count - a.count || a.lang.localeCompare(b.lang));

  const bySource = [...countBy(samples, (s) => s.source).entries()]
    .map(([source, rows]) => ({ source, count: rows.length }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  const byDetectorVersion = [...countBy(samples, (s) => s.detectorVersion).entries()]
    .map(([detectorVersion, rows]) => ({ detectorVersion, count: rows.length }))
    .sort((a, b) => b.count - a.count || a.detectorVersion.localeCompare(b.detectorVersion));

  const meanConfidence = total === 0 ? null : samples.reduce((a, s) => a + s.confidence, 0) / total;
  const lowConfidenceRate =
    total === 0
      ? null
      : samples.filter((s) => s.confidence < lowConfidenceThreshold).length / total;

  return {
    total,
    byLanguage,
    bySource,
    byDetectorVersion,
    meanConfidence,
    lowConfidenceRate,
    lowConfidenceThreshold,
  };
}
