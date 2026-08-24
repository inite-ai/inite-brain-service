import type { MetricsReader } from './metrics-reader';
import { sumCounter } from './metrics-reader';
import type { MriDimension, MriReport } from './mri.types';
import {
  collectOperatingPoint,
  type CollectOperatingPointOptions,
  type PolicyOperatingPoint,
} from './economics';
import {
  ISOLATION_SUITE,
  PREMISE_SUITE,
  POISONING_SUITE,
  type SuiteLedger,
  type SuiteSpec,
} from './suite-status';

/**
 * The MRI aggregator (§2 table). Pure over an injected telemetry reader + a
 * suite-status ledger, so the whole thing is unit-testable with a stub source.
 * Every cell is honestly one of:
 *   - LIVE       — a real number off Prometheus counters/histograms
 *   - STRUCTURAL — a suite's last-recorded pass status (never a guessed pass)
 *   - PENDING    — the `'pending-eval'` sentinel + a reason (labels/eval/F1)
 */

/** No real value available (empty window / not-yet-labeled) → honest sentinel. */
function pendingCell(args: {
  source: string;
  reason: string;
  evalGated: boolean;
  kind: 'live' | 'pending';
  asOf: string;
}): MriDimension {
  return {
    value: 'pending-eval',
    source: args.source,
    asOf: args.asOf,
    evalGated: args.evalGated,
    reason: args.reason,
    kind: args.kind,
  };
}

/** Premise-awareness / poisoning / isolation share the ledger-backed shape. */
function structuralDim(
  spec: SuiteSpec,
  args: { ledger: SuiteLedger; nowIso: string; preferNumericGap?: boolean },
): MriDimension {
  const { ledger, nowIso } = args;
  const entry = ledger[spec.key];
  const suiteRef = spec.files.join(', ');
  const docRef = spec.doc ? ` (${spec.doc})` : '';
  if (!entry) {
    return {
      value: 'unrecorded',
      source: `suite ${suiteRef}${docRef}`,
      asOf: nowIso,
      evalGated: false,
      kind: 'structural',
      reason: `suite present but last-run status not recorded — run \`pnpm mri:record-suite ${spec.key}\``,
    };
  }
  const commitRef = entry.commit ? ` @ ${entry.commit}` : '';
  const gapNote = entry.gapCount !== undefined ? `, gapCount=${entry.gapCount}` : '';
  const countNote =
    entry.numPassed !== undefined || entry.numFailed !== undefined
      ? `, tests ${entry.numPassed ?? 0} passed/${entry.numFailed ?? 0} failed`
      : '';
  const source = `suite ${suiteRef} — status ${entry.status}, recorded ${entry.recordedAt}${commitRef}${gapNote}${countNote}`;
  if (args.preferNumericGap && entry.gapCount !== undefined) {
    return {
      value: entry.gapCount,
      unit: 'gaps',
      source,
      asOf: entry.recordedAt,
      evalGated: false,
      kind: 'structural',
    };
  }
  return {
    value: entry.status,
    source,
    asOf: entry.recordedAt,
    evalGated: false,
    kind: 'structural',
  };
}

/**
 * Premise-awareness — structural. MemTrap shakedown pass status, enriched with
 * the FOVEA_PLAUSIBILITY_CHECK downgrade counter IF the serving path emits one
 * (it currently does not — noted in source, never fabricated).
 */
function premiseAwarenessDim(
  reader: MetricsReader,
  ledger: SuiteLedger,
  nowIso: string,
): MriDimension {
  const base = structuralDim(PREMISE_SUITE, { ledger, nowIso });
  const plausibilitySeries = reader.counter('brain_fovea_plausibility_downgrade_total');
  if (plausibilitySeries.length > 0) {
    const downgrades = sumCounter(reader, 'brain_fovea_plausibility_downgrade_total');
    return { ...base, source: `${base.source}; FOVEA_PLAUSIBILITY_CHECK downgrades=${downgrades}` };
  }
  return {
    ...base,
    source: `${base.source}; FOVEA_PLAUSIBILITY_CHECK downgrade counter not emitted`,
  };
}

/**
 * Citation coverage — % of served `supported` answers with ≥1 citation. Wired
 * forward-compatibly: computes the real ratio IF the serving path emits the
 * supported / supported-cited counters. It does NOT today, and adding the
 * increment would edit synthesize.service.ts/verdict.ts (out of scope for this
 * read-only layer), so it renders the honest sentinel with that reason.
 */
function citationCoverageDim(reader: MetricsReader, nowIso: string): MriDimension {
  const supportedSeries = reader.counter('brain_synthesize_supported_total');
  const supported = sumCounter(reader, 'brain_synthesize_supported_total');
  const cited = sumCounter(reader, 'brain_synthesize_supported_cited_total');
  if (supportedSeries.length > 0 && supported > 0) {
    return {
      value: cited / supported,
      unit: 'ratio',
      source: 'brain_synthesize_supported_cited_total ÷ brain_synthesize_supported_total',
      asOf: nowIso,
      evalGated: false,
      kind: 'live',
    };
  }
  return pendingCell({
    source: 'synthesize verdict/citation counters (not emitted by serving path)',
    reason:
      'no citation-vs-supported counter is emitted on the serving path; computing % of supported ' +
      'answers with ≥1 citation requires instrumenting synthesize.service.ts/verdict.ts, which this ' +
      'read-only measurement layer must not touch. Auto-fills once brain_synthesize_supported_total ' +
      '& brain_synthesize_supported_cited_total appear.',
    evalGated: false,
    kind: 'live',
    asOf: nowIso,
  });
}

/** Cost & latency — live (Part 1 axes). tokens/query off the token counters. */
function tokensPerQueryDim(reader: MetricsReader, nowIso: string): MriDimension {
  const synthTotal = sumCounter(reader, 'brain_synthesize_total');
  const tokens = sumCounter(reader, 'brain_openai_tokens_total');
  if (synthTotal <= 0) {
    return pendingCell({
      source: 'brain_openai_tokens_total ÷ brain_synthesize_total',
      reason: 'no synthesize traffic in the current window (0 queries) — no rate to report',
      evalGated: false,
      kind: 'live',
      asOf: nowIso,
    });
  }
  return {
    value: tokens / synthTotal,
    unit: 'tokens/query',
    source: 'brain_openai_tokens_total ÷ brain_synthesize_total',
    asOf: nowIso,
    evalGated: false,
    kind: 'live',
  };
}

function costLatencyDims(
  point: PolicyOperatingPoint,
  nowIso: string,
): Record<string, MriDimension> {
  const costSource =
    'brain_openai_tokens_total × assumed price table (tokens exact; USD conversion assumed) ÷ brain_synthesize_total';
  const latencySource =
    'brain_search_duration_seconds histogram quantile (search-stage; no end-to-end query histogram is emitted)';

  const cost: MriDimension =
    point.costPerQuery === null
      ? pendingCell({
          source: costSource,
          reason: 'no synthesize traffic in the current window (0 queries)',
          evalGated: false,
          kind: 'live',
          asOf: nowIso,
        })
      : {
          value: point.costPerQuery,
          unit: 'USD/query',
          source: costSource,
          asOf: nowIso,
          evalGated: false,
          kind: 'live',
        };

  const p50: MriDimension =
    point.latencyP50 === null
      ? pendingCell({
          source: latencySource,
          reason: 'no search-latency samples in the current window',
          evalGated: false,
          kind: 'live',
          asOf: nowIso,
        })
      : {
          value: point.latencyP50,
          unit: 'seconds',
          source: latencySource,
          asOf: nowIso,
          evalGated: false,
          kind: 'live',
        };

  const p95: MriDimension =
    point.latencyP95 === null
      ? pendingCell({
          source: latencySource,
          reason: 'no search-latency samples in the current window',
          evalGated: false,
          kind: 'live',
          asOf: nowIso,
        })
      : {
          value: point.latencyP95,
          unit: 'seconds',
          source: latencySource,
          asOf: nowIso,
          evalGated: false,
          kind: 'live',
        };

  return { costPerQueryUsd: cost, latencyP50Seconds: p50, latencyP95Seconds: p95 };
}

export interface BuildMriReportOptions {
  now?: Date;
  operatingPoint?: CollectOperatingPointOptions;
}

/**
 * Assemble the full MRI report from a telemetry reader + a suite-status ledger.
 * Pure and deterministic (given `now`) — the service supplies a live reader and
 * the committed ledger; unit tests supply a stub reader and an in-memory ledger.
 */
export function buildMriReport(
  reader: MetricsReader,
  ledger: SuiteLedger,
  options: BuildMriReportOptions = {},
): MriReport {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const point = collectOperatingPoint(reader, options.operatingPoint ?? {});

  const dimensions: Record<string, MriDimension> = {
    // Structural (suite-backed) ------------------------------------------
    premiseAwareness: premiseAwarenessDim(reader, ledger, nowIso),
    poisoningResistance: structuralDim(POISONING_SUITE, { ledger, nowIso, preferNumericGap: true }),
    tenantUserIsolation: structuralDim(ISOLATION_SUITE, { ledger, nowIso }),

    // Live telemetry -----------------------------------------------------
    citationCoverage: citationCoverageDim(reader, nowIso),
    tokensPerQuery: tokensPerQueryDim(reader, nowIso),
    ...costLatencyDims(point, nowIso),

    // Pending — freshness is blocked on F1 (must land first; not built here)
    freshnessStaleAnswerRate: pendingCell({
      source: 'answer-cache invalidation telemetry (brain_answer_cache_total{rejected_stale})',
      reason:
        'blocked on F1 answer-cache additive-write invalidation — the stale-answer rate is only ' +
        'meaningful once F1 lands; F1 is out of scope for this measurement layer',
      evalGated: false,
      kind: 'pending',
      asOf: nowIso,
    }),

    // Pending — eval-gated (need a labeled gold set)
    abstentionCalibration: pendingCell({
      source: 'Fovea §4.2 focus-signal reliability (per-class ECE over labeled abstain decisions)',
      reason:
        'eval-gated: needs a labeled gold set (correct/abstain outcomes) to compute focus-signal ' +
        'reliability; no labels exist yet',
      evalGated: true,
      kind: 'pending',
      asOf: nowIso,
    }),
    correctness: pendingCell({
      source: 'parked paid-accuracy eval (strict-judged LoCoMo / LME / BEAM)',
      reason:
        'eval-gated: the paid-accuracy eval is frozen; no true-correctness number until it is unfrozen',
      evalGated: true,
      kind: 'pending',
      asOf: nowIso,
    }),
  };

  return { generatedAt: nowIso, dimensions, operatingPoint: point };
}
