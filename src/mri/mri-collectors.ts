import type { MetricsReader } from './metrics-reader';
import { sumCounter } from './metrics-reader';
import type { MriDimension, MriReport, MriWindow } from './mri.types';
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
  const passed = entry.status === 'pass';
  // gapCount is a HEALTH value only on a PASS. On a failed run a `0` gap reads
  // as "0 gaps → healthy" — a false green — while the suite that establishes it
  // actually went red. So the numeric gap (both the reported value AND the
  // source note) is suppressed unless the run passed; a failed entry renders
  // its `fail` status instead. (R3 P1: gapCount must be omitted on a red entry.)
  const gapNote = passed && entry.gapCount !== undefined ? `, gapCount=${entry.gapCount}` : '';
  const countNote =
    entry.numPassed !== undefined || entry.numFailed !== undefined
      ? `, tests ${entry.numPassed ?? 0} passed/${entry.numFailed ?? 0} failed`
      : '';
  const source = `suite ${suiteRef} — status ${entry.status}, recorded ${entry.recordedAt}${commitRef}${gapNote}${countNote}`;
  if (args.preferNumericGap && passed && entry.gapCount !== undefined) {
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
 * judge that downgrades an implausible cited premise to an abstain). But a
 * flag being ON is NOT evidence the exposure is closed — "the defense code
 * runs" ≠ "we are premise-aware". So this cell is EVIDENCE-gated, never
 * flag-gated (R3 P1):
 *   - defense OFF  → `exposed` (never a pass): the documented belief-distortion
 *     answer is live. Backed by the suite that documents the exposure.
 *   - defense ON   → `pending-eval` (eval-gated), NOT `defended`: the judge
 *     runs, but no eval asserts the documented class-4 belief-distortion case
 *     is actually downgraded with the defense on. The live downgrade count
 *     (brain_plausibility_downgrade_total) is surfaced as ACTIVITY, not proof.
 *     A green `defended` is only earned by such eval evidence, which does not
 *     yet exist.
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

  // Flag ON does NOT earn a green `defended`. Report honest-pending (eval-gated):
  // the plausibility judge runs, but no eval proves the documented belief-
  // distortion exposure is actually closed. The live downgrade count is
  // surfaced as ACTIVITY (the judge is firing), never as proof of defense.
  const downgrades = sumCounter(reader, 'brain_plausibility_downgrade_total');
  return {
    value: 'pending-eval',
    source:
      `FOVEA_PLAUSIBILITY_CHECK ON; brain_plausibility_downgrade_total downgrades=${downgrades} ` +
      `(activity, not proof of defense); ${suiteStatus}`,
    asOf: nowIso,
    evalGated: true,
    kind: 'pending',
    reason:
      'FOVEA_PLAUSIBILITY_CHECK is enabled, so the post-grounding plausibility judge runs — but ' +
      'flag-state is not premise-awareness. No eval asserts the documented belief-distortion exposure ' +
      '(MemTrap shakedown class 4) is actually downgraded with the defense on, so the defense is ' +
      'enabled-but-UNVERIFIED. Reported pending until such a labeled case exists — never a green ' +
      '`defended`.',
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
 * Freshness — the stale-answer catch rate off the answer-cache invalidation
 * telemetry. F1 (answer-cache additive-write invalidation, #339) is MERGED, so
 * this is now a REAL read-only signal rather than the stale "blocked on F1"
 * pending: of the cache-backed reads (an entry existed), the fraction the
 * check-on-read invalidated as stale = rejected_stale ÷ (hit + rejected_stale).
 * A `miss`/`bypass` had no entry to be stale, so it is excluded from the
 * denominator.
 *
 * When the window saw no cache-backed reads — the DEFAULT, since
 * SYNTHESIZE_ANSWER_CACHE is off so `begin()` short-circuits and emits nothing —
 * the rate is unobservable and renders honest-pending with that reason, never a
 * fabricated 0 (which would read as "never stale → healthy").
 */
function freshnessDim(reader: MetricsReader, nowIso: string): MriDimension {
  const series = reader.counter('brain_answer_cache_total');
  const hit = sumCounter(reader, 'brain_answer_cache_total', { outcome: 'hit' });
  const rejectedStale = sumCounter(reader, 'brain_answer_cache_total', {
    outcome: 'rejected_stale',
  });
  const reads = hit + rejectedStale;
  const source =
    'brain_answer_cache_total{outcome=rejected_stale} ÷ (hit + rejected_stale) — check-on-read ' +
    'staleness catch rate (F1 additive-write invalidation, #339)';
  if (series.length === 0 || reads <= 0) {
    return pendingCell({
      source,
      reason:
        'no answer-cache read traffic in the current window: SYNTHESIZE_ANSWER_CACHE is default-off, ' +
        'so the cache serves no reads and the stale-answer rate is unobservable. Auto-fills once the ' +
        'cache is enabled and serves hits / stale-rejections.',
      evalGated: false,
      kind: 'live',
      asOf: nowIso,
    });
  }
  return {
    value: rejectedStale / reads,
    unit: 'ratio (stale-rejected ÷ cache-backed reads)',
    source,
    asOf: nowIso,
    evalGated: false,
    kind: 'live',
  };
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
  /**
   * The rolling window the LIVE rate cells cover, when the caller (the service)
   * deltas process-lifetime counters against a baseline snapshot. Embedded in
   * the report so a consumer sees the numbers are windowed, not lifetime. Absent
   * for a pure buildMriReport call over a raw reader (unit tests).
   */
  window?: MriWindow;
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

    // Freshness — REAL signal now F1 (answer-cache invalidation, #339) is
    // merged; honest-pending only when there is no cache read traffic.
    freshnessStaleAnswerRate: freshnessDim(reader, nowIso),

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

  return {
    generatedAt: nowIso,
    dimensions,
    operatingPoint: point,
    ...(options.window ? { window: options.window } : {}),
  };
}
