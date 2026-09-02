import type { VerifierOutput } from './verifier';
import { verifierPasses } from './l3-escalation';

/**
 * Verifier-controlled fragment zoom (FOVEA_FRAGMENT_ZOOM, MM-zoom PR3)
 * — the pure decision core + the IO-injected runner. No DI, no env: the
 * orchestrator resolves the flag/knob in the common layer and supplies
 * the two IO ports (fetch fuller derived text, re-verify), the
 * l3-escalation.ts split idiom.
 *
 * THE ONE STEP: when the primary verifier verdict FAILS and at least one
 * RENDERED fragment line was TRUNCATED by the lane's 600-char excerpt
 * cap (ZoomCandidate.truncated — recorded at render time, no extra
 * read), fetch the fuller text of the SAME derived_representation rows
 * (≤ maxChars each, ≤ FRAGMENT_ZOOM_MAX_FRAGMENTS fragments, cited
 * fragments first) and re-run the SAME verifier over the enriched
 * evidence document. The ANSWER is never regenerated: a flip means the
 * already-served answer was grounded in text the excerpt cap had hidden
 * from the auditor. No flip (or any failure) returns null and the
 * caller's downgrade path runs byte-identically.
 *
 * DERIVED TEXT ONLY — NEVER RAW BYTES: the zoom reads
 * derived_representation.content through the lane's own fence stack
 * (FragmentLaneService.fullerTexts). Original media bytes stay
 * exclusively behind the raw-read gateway (EVIDENCE_RAW_READ_ENABLED,
 * EvidenceReadService); this module cannot name them.
 *
 * MONOTONE + BOUNDED + FAIL-SAFE (the adaptive-L3 ladder shape): the
 * flow is linear so the step runs at most once per request; the fetch is
 * bounded by the fragment cap × char cap; every error path counts
 * 'error' and returns null — the zoom can only ADD a flipped verdict,
 * never lose the static behavior.
 */

/** Ceiling on fragments zoomed per step (design constant, deliberately
 *  NOT an env knob until the step is measured — the lane top-K idiom). */
export const FRAGMENT_ZOOM_MAX_FRAGMENTS = 2;

/**
 * One rendered fragment line's zoom affordance, recorded by the lane at
 * render time (fragment-lane.service.ts render()) — pure bookkeeping
 * over rows already in memory, no IO and no rendered-byte change.
 */
export interface ZoomCandidate {
  /** evidence_fragment record id (the citedFragmentIds join key). */
  fragmentId: string;
  /** The derived_representation row whose content the line excerpted —
   *  the row the zoom re-reads for its fuller text. */
  reprId: string;
  /** Index of the fragment's line within the lane's rendered lines. */
  lineIndex: number;
  /** Everything before the excerpt on the rendered line — the zoomed
   *  line is linePrefix + fullerText, format-identical to the lane's. */
  linePrefix: string;
  /** Whether the excerpt cap actually truncated the content — the
   *  "deeper representation available" trigger bit. */
  truncated: boolean;
}

/** Per-step outcomes (the brain_fragment_zoom_total label values). */
export type FragmentZoomOutcome = 'flipped' | 'unchanged' | 'skipped' | 'error';

/** Metrics port (keeps this module pure — the fragment-citations idiom). */
export interface FragmentZoomMetrics {
  countFragmentZoom(outcome: FragmentZoomOutcome): void;
}

/**
 * Select the fragments to zoom: truncated candidates only, CITED ones
 * first (the generator named them — the likeliest support site), rendered
 * order within each group, deduped by fragmentId, capped. Pure.
 */
export function selectZoomFragments(
  candidates: ReadonlyArray<ZoomCandidate>,
  citedFragmentIds: ReadonlyArray<string>,
  cap: number = FRAGMENT_ZOOM_MAX_FRAGMENTS,
): ZoomCandidate[] {
  const cited = new Set(citedFragmentIds);
  const truncated = candidates.filter((c) => c.truncated);
  const seen = new Set<string>();
  const picked: ZoomCandidate[] = [];
  for (const group of [
    truncated.filter((c) => cited.has(c.fragmentId)),
    truncated.filter((c) => !cited.has(c.fragmentId)),
  ]) {
    for (const c of group) {
      if (picked.length >= cap) return picked;
      if (seen.has(c.fragmentId)) continue;
      seen.add(c.fragmentId);
      picked.push(c);
    }
  }
  return picked;
}

/**
 * Rebuild the evidence lines with the zoomed fragments' fuller text —
 * linePrefix + fullerText at the candidate's own index, every other line
 * byte-identical. A stale candidate (index out of range or prefix
 * mismatch — cannot happen when lane and candidates come from the same
 * render, but the fence is cheap) leaves its line untouched. Pure.
 */
export function buildZoomedLines(
  lines: ReadonlyArray<string>,
  zoomed: ReadonlyArray<{ candidate: ZoomCandidate; fullerText: string }>,
): string[] {
  const out = [...lines];
  for (const { candidate, fullerText } of zoomed) {
    const current = out[candidate.lineIndex];
    if (current === undefined || !current.startsWith(candidate.linePrefix)) continue;
    out[candidate.lineIndex] = candidate.linePrefix + fullerText;
  }
  return out;
}

/** The two IO ports + observability the runner needs. */
export interface FragmentZoomDeps {
  /** Fetch fuller derived TEXT (≤ maxChars each) for the given
   *  derived_representation ids, through the lane's fence stack. */
  fetchFullerTexts(reprIds: string[], maxChars: number): Promise<Map<string, string>>;
  /** Re-run the SAME verifier with the enriched evidence lines standing
   *  in for the rendered fragment lines — everything else identical. */
  reverify(zoomedLines: string[]): Promise<VerifierOutput>;
  metrics?: FragmentZoomMetrics | undefined;
  warn(message: string): void;
}

export interface FragmentZoomArgs {
  /** profile.verifierTopicCoverage — the shared flip-test knob. */
  topicCoverage: boolean;
  /** The lane's rendered fragment lines (the verifier's
   *  capabilityEvidenceLines section). */
  fragmentLines: ReadonlyArray<string>;
  /** Zoom affordances for EXACTLY the rendered fragments. */
  candidates: ReadonlyArray<ZoomCandidate>;
  /** The generator's cited fragment ids (selection preference). */
  citedFragmentIds: ReadonlyArray<string>;
  /** Resolved FOVEA_FRAGMENT_ZOOM_MAX_CHARS. */
  maxChars: number;
}

/** What one zoom evaluation decided — the material captureZoomDecision
 *  maps onto a memory_decision row (kind 'zoom'). */
export interface FragmentZoomResult {
  outcome: FragmentZoomOutcome;
  /** Truncated candidates available to the step. */
  candidateCount: number;
  /** Fragments actually zoomed into the re-verify (0 on skip/error). */
  zoomedCount: number;
  /** The flipped verdict — present ONLY on outcome 'flipped'. */
  verdict?: VerifierOutput | undefined;
}

/**
 * Run the ONE zoom step. Called by the orchestrator ONLY when
 * FOVEA_FRAGMENT_ZOOM is on AND the primary verdict already FAILED the
 * shared flip test (both gates stay in the caller — this module reads no
 * env, and a passing verdict never reaches it, so 'skipped' always means
 * "failed verdict with nothing to zoom"). Returns the evaluation result;
 * only outcome 'flipped' carries a verdict for the caller to serve.
 * Every error path degrades to 'error' + no verdict — the caller's
 * static behavior.
 */
export async function runFragmentZoom(
  deps: FragmentZoomDeps,
  args: FragmentZoomArgs,
): Promise<FragmentZoomResult> {
  const candidateCount = args.candidates.filter((c) => c.truncated).length;
  const done = (outcome: FragmentZoomOutcome, zoomedCount = 0, verdict?: VerifierOutput) => {
    deps.metrics?.countFragmentZoom(outcome);
    return { outcome, candidateCount, zoomedCount, verdict };
  };
  try {
    // Trigger residue: at least one truncated rendered fragment (the
    // failed-verdict gate already ran in the caller). Nothing to zoom
    // ⇒ skip.
    const picked = selectZoomFragments(args.candidates, args.citedFragmentIds);
    if (picked.length === 0) return done('skipped');
    const fuller = await deps.fetchFullerTexts(
      picked.map((c) => c.reprId),
      args.maxChars,
    );
    // Deeper only: a fetch that returned nothing longer than the rendered
    // excerpt (row shrank / vanished / knob below the excerpt cap) skips.
    const zoomed = picked.flatMap((candidate) => {
      const fullerText = fuller.get(candidate.reprId);
      const line = args.fragmentLines[candidate.lineIndex];
      const excerptLength = line === undefined ? 0 : line.length - candidate.linePrefix.length;
      return fullerText !== undefined && fullerText.length > excerptLength
        ? [{ candidate, fullerText }]
        : [];
    });
    if (zoomed.length === 0) return done('skipped');
    const zoomedLines = buildZoomedLines(args.fragmentLines, zoomed);
    // Re-verify ONLY — the answer is never regenerated.
    const verdict = await deps.reverify(zoomedLines);
    return verifierPasses(verdict, args.topicCoverage)
      ? done('flipped', zoomed.length, verdict)
      : done('unchanged', zoomed.length);
  } catch (e) {
    // Fail-safe to static: the step must never break the serve/downgrade.
    deps.warn(`fragment zoom failed: ${(e as Error).message}`);
    return done('error');
  }
}
