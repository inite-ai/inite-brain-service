import type { MetricsReader } from './metrics-reader';
import { histogramQuantile, sumCounter } from './metrics-reader';

/**
 * Part 1 — the economics operating-point + Pareto reporter
 * (docs/roadmap/measurable-economics-mri-2026-08.md §1).
 *
 * A policy operating-point is one row on the accuracy × cost × latency
 * surface: "with THIS flag set, over THIS window, the pipeline served at
 * this proxy-accuracy, this $/query, this p50/p95". Every axis except
 * accuracy comes straight off existing telemetry. The accuracy axis is a
 * cheap ONLINE PROXY — the verifier `supported`-rate — NOT a true accuracy
 * claim; the field is named `accuracyProxy` and labelled "proxy" everywhere
 * so it can never be mistaken for the parked paid-eval number.
 *
 * The reporter renders the Pareto frontier over a set of points and flags
 * the dominated ones (accuracy↑ better, cost↓ better, latency↓ better). The
 * ship-gate is ADVISORY ONLY (§1.3): it REPORTS that a candidate is
 * dominated; it never blocks. Latency/cost are real; only accuracy is a
 * proxy until the eval is unfrozen.
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
 * One point on the accuracy × cost × latency surface. The literal shape from
 * §1: `flags`, `accuracyProxy`, `ece`, `latencyP50`, `latencyP95`,
 * `costPerQuery`. Measured axes are `number | null` — null means "no telemetry
 * in the window", never a fabricated zero (the inviolable rule). `ece` is null
 * until calibration labels exist. `sampleCount` carries the provenance (how
 * many synthesize calls the window saw) so a consumer can see an empty window.
 */
export interface PolicyOperatingPoint {
  /** Flags that describe this operating point (caller-supplied — telemetry
   *  does not record which flags were live for a window). */
  flags: string[];
  /** Verifier `supported`-rate in [0,1]. A PROXY, never a true-accuracy claim.
   *  null when the window saw no synthesize traffic. */
  accuracyProxy: number | null;
  /** Expected Calibration Error. null until a labeled gold set exists. */
  ece: number | null;
  /** Median query latency in seconds (search-stage histogram). null = no
   *  samples. */
  latencyP50: number | null;
  /** p95 query latency in seconds. null = no samples. */
  latencyP95: number | null;
  /** Estimated USD per query (exact token counters × assumed price table).
   *  null = no traffic. */
  costPerQuery: number | null;
  /** synthesize invocations observed in the window (provenance for the axes). */
  sampleCount: number;
}

export interface CollectOperatingPointOptions {
  /** Label the flags that were live for this window (default []). */
  flags?: string[];
  /** Override the price table used for the $ axis. */
  pricing?: PriceTable;
}

/**
 * Assemble ONE operating point from a telemetry reader over the current
 * window. accuracyProxy = supported-rate = synthesize{outcome=ok} ÷ synthesize
 * total. Cost = (prompt/completion/embed tokens × price) ÷ query count. Latency
 * = search-duration histogram quantiles (the only per-query latency histogram
 * the pipeline emits; there is no end-to-end synthesize histogram, and adding
 * one would touch the serving path). ece stays null — no labels here.
 */
export function collectOperatingPoint(
  reader: MetricsReader,
  options: CollectOperatingPointOptions = {},
): PolicyOperatingPoint {
  const pricing = options.pricing ?? DEFAULT_PRICE_TABLE;
  const flags = options.flags ?? [];

  const synthTotal = sumCounter(reader, 'brain_synthesize_total');
  const synthOk = sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' });
  const accuracyProxy = synthTotal > 0 ? synthOk / synthTotal : null;

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
  const costPerQuery = synthTotal > 0 ? totalCostUsd / synthTotal : null;

  const latency = reader.histogram('brain_search_duration_seconds');
  const latencyP50 = latency ? histogramQuantile(latency, 0.5) : null;
  const latencyP95 = latency ? histogramQuantile(latency, 0.95) : null;

  return {
    flags,
    accuracyProxy,
    ece: null,
    latencyP50,
    latencyP95,
    costPerQuery,
    sampleCount: synthTotal,
  };
}

/** True iff every axis the frontier compares is present (not null). */
export function hasCompleteAxes(p: PolicyOperatingPoint): boolean {
  return p.accuracyProxy !== null && p.costPerQuery !== null && p.latencyP95 !== null;
}

/**
 * Pareto domination over (accuracyProxy↑, costPerQuery↓, latencyP95↓): `a`
 * dominates `b` iff `a` is no worse on every axis and strictly better on at
 * least one. Only defined when both points have complete axes.
 */
export function dominates(a: PolicyOperatingPoint, b: PolicyOperatingPoint): boolean {
  if (!hasCompleteAxes(a) || !hasCompleteAxes(b)) return false;
  const aAcc = a.accuracyProxy as number;
  const bAcc = b.accuracyProxy as number;
  const aCost = a.costPerQuery as number;
  const bCost = b.costPerQuery as number;
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
        `$${fmt(candidate.costPerQuery)}/q, p95 ${fmt(candidate.latencyP95)}s) by an incumbent ` +
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
