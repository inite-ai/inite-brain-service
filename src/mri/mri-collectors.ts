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
 * Premise-awareness — the actual belief-distortion DEFENSE posture, NOT merely
 * "the MemTrap suite passed".
 *
 * The MemTrap shakedown suite DOCUMENTS AND ASSERTS current EXPOSURES — its
 * class-4 case asserts that a cited counterfactual/sandbox premise makes a
 * distorted answer verify as `supported` and be SERVED. So a passing suite means
 * "the exposures are as documented / gated against regression", NOT "we are
 * premise-aware". Rendering that as a green `pass` would be a false green.
 *
 * The real defense is FOVEA_PLAUSIBILITY_CHECK (the post-grounding plausibility
 * judge that downgrades an implausible cited premise to an abstain). This cell
 * therefore reflects that flag's state, resolved read-only by the service from
 * `plausibilityCheckEnabled()` and passed in:
 *   - defense OFF  → `exposed` (never a pass): the documented belief-distortion
 *     answer is live. Backed by the suite that documents the exposure.
 *   - defense ON   → `defended`: report the live downgrade activity from
 *     brain_plausibility_downgrade_total (the metric prod actually emits).
 */
function premiseAwarenessDim(args: {
  reader: MetricsReader;
  ledger: SuiteLedger;
  nowIso: string;
  plausibilityCheckEnabled: boolean;
}): MriDimension {
  const { reader, ledger, nowIso, plausibilityCheckEnabled } = args;
  const entry = ledger[PREMISE_SUITE.key];
  const suiteRef = PREMISE_SUITE.files.join(', ');
  const docRef = PREMISE_SUITE.doc ? ` (${PREMISE_SUITE.doc})` : '';
  const suiteStatus = entry
    ? `MemTrap shakedown suite ${suiteRef}${docRef} last-recorded ${entry.status}${
        entry.commit ? ` @ ${entry.commit}` : ''
      } (${entry.recordedAt}) — documents current EXPOSURES, not premise-awareness`
    : `MemTrap shakedown suite ${suiteRef}${docRef} status unrecorded`;

  if (!plausibilityCheckEnabled) {
    return {
      value: 'exposed',
      source: `FOVEA_PLAUSIBILITY_CHECK OFF (no post-grounding plausibility judge); ${suiteStatus}`,
      asOf: nowIso,
      evalGated: false,
      kind: 'structural',
      reason:
        'FOVEA_PLAUSIBILITY_CHECK is off, so the belief-distortion defense does not run: a cited ' +
        'counterfactual/sandbox premise still makes a distorted answer verify as `supported` and be ' +
        'served (MemTrap shakedown class 4, asserted as a CURRENT exposure). A passing MemTrap suite ' +
        'only certifies the exposures are as documented, NOT that we are premise-aware — so this is ' +
        'not a pass.',
    };
  }

  const downgradeSeries = reader.counter('brain_plausibility_downgrade_total');
  const downgrades = sumCounter(reader, 'brain_plausibility_downgrade_total');
  const noActivity =
    downgradeSeries.length === 0
      ? {
          reason:
            'FOVEA_PLAUSIBILITY_CHECK is on but no supported-answer downgrades have been observed ' +
            'in the current window (brain_plausibility_downgrade_total absent/zero)',
        }
      : {};
  return {
    value: 'defended',
    source: `FOVEA_PLAUSIBILITY_CHECK ON; brain_plausibility_downgrade_total downgrades=${downgrades}; ${suiteStatus}`,
    asOf: nowIso,
    evalGated: false,
    kind: 'live',
    ...noActivity,
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

/**
 * Tokens/query — live (Part 1 axis). All-AI tokens ÷ TERMINAL synthesize count
 * (`point.sampleCount`, the per-request denominator — not the double-counting
 * raw brain_synthesize_total). Like cost, this is an UPPER BOUND: the token
 * counters carry no per-subsystem label, so non-synthesize AI tokens are
 * attributed to synthesize requests. Labelled as such, never a per-answer count.
 */
function tokensPerQueryDim(
  reader: MetricsReader,
  point: PolicyOperatingPoint,
  nowIso: string,
): MriDimension {
  const source =
    'brain_openai_tokens_total (all-AI: embed+chat across derive/dreams/ingest/synthesize) ÷ terminal synthesize count — UPPER BOUND, not synthesize-only';
  const tokens = sumCounter(reader, 'brain_openai_tokens_total');
  if (point.sampleCount <= 0) {
    return pendingCell({
      source,
      reason:
        'no terminal synthesize traffic in the current window (0 requests) — no rate to report',
      evalGated: false,
      kind: 'live',
      asOf: nowIso,
    });
  }
  return {
    value: tokens / point.sampleCount,
    unit: 'tokens/query (all-AI upper bound)',
    source,
    asOf: nowIso,
    evalGated: false,
    kind: 'live',
  };
}

function costLatencyDims(
  point: PolicyOperatingPoint,
  nowIso: string,
): Record<string, MriDimension> {
  // Cost is an UPPER BOUND: the token counters are not separable by subsystem,
  // so global AI spend is divided by the synthesize request count. The cell key,
  // unit, and source all say so — it is never presented as the per-answer cost.
  const costSource =
    'all-AI tokens (embed+chat across derive/dreams/ingest/synthesize — NOT synthesize-only; the token counters carry no per-subsystem label) × assumed price table ÷ terminal synthesize count. UPPER BOUND, not the true per-answer cost.';
  // No per-query latency histogram is emitted on the serving path:
  // brain_search_duration_seconds is defined in metrics.service.ts but
  // observeSearchDuration() is never called outside a unit test. Adding a
  // serving-path histogram is a separate follow-up (this layer is read-only), so
  // latency renders `pending` with that reason — never a fabricated number.
  const latencyReason = 'no per-query latency histogram is emitted on the serving path';
  const latencySource =
    'per-query latency histogram (brain_search_duration_seconds is defined but never observed on the serving path)';

  const cost: MriDimension =
    point.costPerQueryUpperBound === null
      ? pendingCell({
          source: costSource,
          reason: 'no terminal synthesize traffic in the current window (0 requests)',
          evalGated: false,
          kind: 'live',
          asOf: nowIso,
        })
      : {
          value: point.costPerQueryUpperBound,
          unit: 'USD/query (all-AI upper bound)',
          source: costSource,
          asOf: nowIso,
          evalGated: false,
          kind: 'live',
        };

  const latencyPending = (): MriDimension =>
    pendingCell({
      source: latencySource,
      reason: latencyReason,
      evalGated: false,
      kind: 'pending',
      asOf: nowIso,
    });

  return {
    costPerQueryUpperBoundUsd: cost,
    latencyP50Seconds: latencyPending(),
    latencyP95Seconds: latencyPending(),
  };
}

export interface BuildMriReportOptions {
  now?: Date;
  operatingPoint?: CollectOperatingPointOptions;
  /**
   * Actual premise/belief-distortion DEFENSE state — whether
   * FOVEA_PLAUSIBILITY_CHECK is enabled. Drives the premise-awareness cell (a
   * passing MemTrap suite documents EXPOSURES, so suite-pass alone is NOT
   * premise-awareness). Resolved read-only by the service from
   * `plausibilityCheckEnabled()`. Defaults to `false` (conservative: an
   * unknown/off defense never renders a green pass — it renders `exposed`).
   */
  plausibilityCheckEnabled?: boolean;
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
  const plausibilityCheckEnabled = options.plausibilityCheckEnabled ?? false;

  const dimensions: Record<string, MriDimension> = {
    // Defense posture (reflects the real defense state, not a suite pass) --
    premiseAwareness: premiseAwarenessDim({ reader, ledger, nowIso, plausibilityCheckEnabled }),

    // Structural (suite-backed) ------------------------------------------
    poisoningResistance: structuralDim(POISONING_SUITE, { ledger, nowIso, preferNumericGap: true }),
    tenantUserIsolation: structuralDim(ISOLATION_SUITE, { ledger, nowIso }),

    // Live telemetry -----------------------------------------------------
    citationCoverage: citationCoverageDim(reader, nowIso),
    tokensPerQuery: tokensPerQueryDim(reader, point, nowIso),
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
