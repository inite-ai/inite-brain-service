import type { MetricsReader } from './metrics-reader';
import { histogramQuantile, sumCounter } from './metrics-reader';

/**
 * Part 1 — the economics operating-point + Pareto reporter
 * (docs/roadmap/measurable-economics-mri-2026-08.md §1).
 *
 * A policy operating-point is one row on the accuracy × cost × latency
 * surface: "with THIS flag set, over THIS window, the pipeline served at
 * this proxy-accuracy, this $/query, this p50/p95". The accuracy axis is a
 * cheap ONLINE PROXY — the verifier `supported`-rate — NOT a true accuracy
 * claim; the field is named `accuracyProxy` and labelled "proxy" everywhere
 * so it can never be mistaken for the parked paid-eval number.
 *
 * HONESTY FIXES over the first cut (all so a green cell means what it says):
 *   - accuracyProxy denominator = TERMINAL synthesize outcomes only. A single
 *     request can bump brain_synthesize_total more than once (the intermediate
 *     `generator_truncated` / `search_loop_refined` tags), so the raw total is
 *     NOT the request count. We sum only the per-request terminal set
 *     (TERMINAL_SYNTHESIZE_OUTCOMES) for the denominator.
 *   - cost is an UPPER BOUND, not the per-answer cost. The token counters carry
 *     no per-subsystem label, so `costPerQueryUpperBound` divides GLOBAL AI
 *     tokens (embed + chat across derive/dreams/ingest/synthesize) by the
 *     synthesize request count — it over-attributes non-synthesize spend. The
 *     field name + labels say so; it is never presented as the true answer cost.
 *   - latency is LIVE off `brain_search_duration_seconds`: synthesize()
 *     observes its wall-clock duration once per request at the serving
 *     boundary (the audit pt-8 fix — the histogram was defined but never
 *     observed), and p50/p95 come from `histogramQuantile` over its buckets —
 *     the Prometheus estimator, an honest bucket interpolation, not a claimed
 *     exact latency. A window with no samples still yields `null` → the cell
 *     renders `pending`, never a fabricated number.
 *
 * The reporter renders the Pareto frontier over a set of points and flags
 * the dominated ones (accuracy↑ better, cost↓ better, latency↓ better). The
 * ship-gate is ADVISORY ONLY (§1.3): it REPORTS that a candidate is
 * dominated; it never blocks. Only the accuracy axis is a proxy; cost is an
 * explicit upper bound.
 */

/** USD per 1,000,000 tokens. Assumed list price — the token COUNTS are exact
 *  telemetry; this table is only the unit conversion and is overridable so a
 *  deployment can price its own models. Kept deliberately conservative and
 *  explicit: a wrong price shifts the $ axis uniformly, it never fabricates a
 *  measurement. */
export interface PriceTable {
  chatPromptPerMillion: number;
  chatCompletionPerMillion: number;
  embedPromptPerMillion: number;
}

export const DEFAULT_PRICE_TABLE: PriceTable = {
  chatPromptPerMillion: 0.15,
  chatCompletionPerMillion: 0.6,
  embedPromptPerMillion: 0.02,
};

/**
 * One point on the accuracy × cost × latency surface: `flags`, `accuracyProxy`,
 * `ece`, `latencyP50`, `latencyP95`, `costPerQueryUpperBound`. Measured axes are
 * `number | null` — null means "no telemetry / no serving-path signal", never a
 * fabricated zero (the inviolable rule). `ece` is null until calibration labels
 * exist. `sampleCount` carries the provenance (terminal synthesize requests the
 * window saw) so a consumer can see an empty window.
 */
export interface PolicyOperatingPoint {
  /** Flags that describe this operating point (caller-supplied — telemetry
   *  does not record which flags were live for a window). */
  flags: string[];
  /** Verifier `supported`-rate in [0,1] = ok ÷ TERMINAL synthesize outcomes. A
   *  PROXY, never a true-accuracy claim. null when the window saw no terminal
   *  synthesize traffic. */
  accuracyProxy: number | null;
  /** Expected Calibration Error. null until a labeled gold set exists. */
  ece: number | null;
  /** Median query latency in seconds — histogram_quantile(0.5) over
   *  brain_search_duration_seconds (observed once per synthesize() request
   *  at the serving boundary). null when the window carries no samples —
   *  never a fabricated zero. */
  latencyP50: number | null;
  /** p95 query latency in seconds (see latencyP50). */
  latencyP95: number | null;
  /** Estimated USD per query — UPPER BOUND, NOT the true per-answer cost. All-AI
   *  tokens (embed + chat across derive/dreams/ingest/synthesize — the token
   *  counters carry no per-subsystem label) × assumed price ÷ terminal
   *  synthesize count, so it over-attributes non-synthesize AI spend to
   *  synthesize requests. null = no terminal synthesize traffic. */
  costPerQueryUpperBound: number | null;
  /** Terminal synthesize requests observed in the window (each request lands in
   *  exactly one terminal outcome; intermediate outcomes excluded). Provenance
   *  for the axes and the per-request denominator. */
  sampleCount: number;
}

export interface CollectOperatingPointOptions {
  /** Label the flags that were live for this window (default []). */
  flags?: string[];
  /** Override the price table used for the $ axis. */
  pricing?: PriceTable;
}

/**
 * The synthesize outcomes that fire EXACTLY ONCE per request — the request's
 * terminal disposition. Each served request lands in exactly one of these, so
 * their sum is the honest per-request denominator.
 *
 * EXCLUDED (intermediate — they fire ALONGSIDE a terminal outcome, so counting
 * them double-counts the request):
 *   - `generator_truncated`  — the generator hit the token cap and its partial
 *      answer was salvaged (generator-client.ts); the salvaged answer still
 *      flows on to a terminal verdict.
 *   - `search_loop_refined`  — the V13 constrained refine round ran
 *      (synthesize.service.ts); "the final outcome is still counted separately".
 *
 * Enumerated from metrics.service.ts `countSynthesize`. Keep in sync if a new
 * TERMINAL outcome is added there — a missing terminal outcome would understate
 * the denominator and INFLATE the proxy, so this list is the source of truth.
 */
export const TERMINAL_SYNTHESIZE_OUTCOMES = [
  'ok',
  'no_results',
  'no_grounded_evidence',
  'low_coverage',
  'verifier_partial',
  'verifier_failed',
  'generator_error',
  'verifier_error',
] as const;

const TERMINAL_SYNTHESIZE_SET: ReadonlySet<string> = new Set(TERMINAL_SYNTHESIZE_OUTCOMES);

/**
 * Count of TERMINAL synthesize outcomes in the window = number of requests that
 * reached a final disposition (the honest per-request denominator). Series whose
 * `outcome` is intermediate or absent are excluded.
 */
export function terminalSynthesizeCount(reader: MetricsReader): number {
  let total = 0;
  for (const s of reader.counter('brain_synthesize_total')) {
    const outcome = s.labels['outcome'];
    if (outcome !== undefined && TERMINAL_SYNTHESIZE_SET.has(outcome)) total += s.value;
  }
  return total;
}

/**
 * Assemble ONE operating point from a telemetry reader over the current window.
 *   - accuracyProxy = ok ÷ TERMINAL synthesize outcomes (per-request denominator,
 *     never the double-counting raw total).
 *   - costPerQueryUpperBound = (all-AI tokens × price) ÷ terminal count. An UPPER
 *     BOUND: the token counters are not separable by subsystem, so global AI
 *     spend is attributed to synthesize requests. NOT the per-answer cost.
 *   - latencyP50/P95 = histogram_quantile over brain_search_duration_seconds
 *     (observed once per synthesize() request at the serving boundary); null
 *     when the window carries no samples (never fabricated).
 *   - ece stays null — no labels here.
 */
export function collectOperatingPoint(
  reader: MetricsReader,
  options: CollectOperatingPointOptions = {},
): PolicyOperatingPoint {
  const pricing = options.pricing ?? DEFAULT_PRICE_TABLE;
  const flags = options.flags ?? [];

  const terminalTotal = terminalSynthesizeCount(reader);
  const synthOk = sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' });
  const accuracyProxy = terminalTotal > 0 ? synthOk / terminalTotal : null;

  const chatPrompt = sumCounter(reader, 'brain_openai_tokens_total', {
    kind: 'chat',
    type: 'prompt',
  });
  const chatCompletion = sumCounter(reader, 'brain_openai_tokens_total', {
    kind: 'chat',
    type: 'completion',
  });
  const embedPrompt = sumCounter(reader, 'brain_openai_tokens_total', {
    kind: 'embed',
    type: 'prompt',
  });
  const totalCostUsd =
    (chatPrompt * pricing.chatPromptPerMillion +
      chatCompletion * pricing.chatCompletionPerMillion +
      embedPrompt * pricing.embedPromptPerMillion) /
    1_000_000;
  const costPerQueryUpperBound = terminalTotal > 0 ? totalCostUsd / terminalTotal : null;

  // Serving-boundary latency: synthesize() observes once per request.
  // histogramQuantile returns null on an empty histogram (count 0), and a
  // missing metric reads as null too — the never-fabricate rule holds.
  const latencyHist = reader.histogram('brain_search_duration_seconds');
  const latencyP50 = latencyHist ? histogramQuantile(latencyHist, 0.5) : null;
  const latencyP95 = latencyHist ? histogramQuantile(latencyHist, 0.95) : null;

  return {
    flags,
    accuracyProxy,
    ece: null,
    latencyP50,
    latencyP95,
    costPerQueryUpperBound,
    sampleCount: terminalTotal,
  };
}

/** True iff every axis the frontier compares is present (not null). */
export function hasCompleteAxes(p: PolicyOperatingPoint): boolean {
  return p.accuracyProxy !== null && p.costPerQueryUpperBound !== null && p.latencyP95 !== null;
}

/**
 * Pareto domination over (accuracyProxy↑, costPerQueryUpperBound↓,
 * latencyP95↓): `a` dominates `b` iff `a` is no worse on every axis and strictly
 * better on at least one. Only defined when both points have complete axes.
 */
export function dominates(a: PolicyOperatingPoint, b: PolicyOperatingPoint): boolean {
  if (!hasCompleteAxes(a) || !hasCompleteAxes(b)) return false;
  const aAcc = a.accuracyProxy as number;
  const bAcc = b.accuracyProxy as number;
  const aCost = a.costPerQueryUpperBound as number;
  const bCost = b.costPerQueryUpperBound as number;
  const aLat = a.latencyP95 as number;
  const bLat = b.latencyP95 as number;

  const noWorse = aAcc >= bAcc && aCost <= bCost && aLat <= bLat;
  const strictlyBetter = aAcc > bAcc || aCost < bCost || aLat < bLat;
  return noWorse && strictlyBetter;
}

export interface DominatedPoint {
  point: PolicyOperatingPoint;
  dominatedBy: PolicyOperatingPoint;
}

export interface ParetoReport {
  /** Non-dominated points (the frontier). */
  frontier: PolicyOperatingPoint[];
  /** Dominated points, each paired with a point that dominates it. */
  dominated: DominatedPoint[];
  /** Points excluded from the comparison for missing an axis (null value). */
  insufficientData: PolicyOperatingPoint[];
}

/**
 * Render the Pareto frontier over a set of operating points and flag the
 * dominated ones. Points missing an axis are set aside as insufficientData
 * (never silently treated as zero). Advisory reporting only — this computes
 * the frontier, it does not gate anything.
 */
export function paretoFrontier(points: PolicyOperatingPoint[]): ParetoReport {
  const complete = points.filter(hasCompleteAxes);
  const insufficientData = points.filter((p) => !hasCompleteAxes(p));

  const frontier: PolicyOperatingPoint[] = [];
  const dominated: DominatedPoint[] = [];

  for (const p of complete) {
    const dominator = complete.find((q) => q !== p && dominates(q, p));
    if (dominator) dominated.push({ point: p, dominatedBy: dominator });
    else frontier.push(p);
  }

  return { frontier, dominated, insufficientData };
}

export interface ShipGateAdvisory {
  /** Whether an incumbent dominates the candidate on the three axes. */
  candidateDominated: boolean;
  /** The dominating incumbent, if any. */
  dominatedBy: PolicyOperatingPoint | null;
  /** Human-readable advisory sentence. */
  advisory: string;
  /** ALWAYS false — this gate reports, it never blocks (§1.3). */
  blocking: false;
}

/**
 * Advisory ship-gate (§1.3): report whether `candidate` is dominated by any
 * `incumbent`. Deliberately never blocks — `blocking` is a literal `false`.
 * Until the eval is unfrozen the accuracy axis is a proxy, so a domination
 * verdict is advice, not a merge gate.
 */
export function shipGateAdvisory(
  candidate: PolicyOperatingPoint,
  incumbents: PolicyOperatingPoint[],
): ShipGateAdvisory {
  if (!hasCompleteAxes(candidate)) {
    return {
      candidateDominated: false,
      dominatedBy: null,
      advisory:
        'advisory: candidate has no telemetry on ≥1 axis (proxy-accuracy / cost / p95); ' +
        'no domination verdict possible.',
      blocking: false,
    };
  }
  const dominator = incumbents.find((q) => dominates(q, candidate)) ?? null;
  if (dominator) {
    return {
      candidateDominated: true,
      dominatedBy: dominator,
      advisory:
        `advisory: candidate is DOMINATED (proxy-accuracy ${fmt(candidate.accuracyProxy)}, ` +
        `$${fmt(candidate.costPerQueryUpperBound)}/q upper-bound, p95 ${fmt(candidate.latencyP95)}s) by an incumbent ` +
        `[${dominator.flags.join(',') || 'baseline'}]. Not blocking — accuracy is a proxy until eval is unfrozen.`,
      blocking: false,
    };
  }
  return {
    candidateDominated: false,
    dominatedBy: null,
    advisory: 'advisory: candidate is on the frontier (not dominated by any incumbent).',
    blocking: false,
  };
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toPrecision(3);
}
