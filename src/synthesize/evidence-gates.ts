import type { RetrievalProfile, LaneId } from '../search/retrieval-profile';
import {
  resolveVerbatimMode,
  detectVerbatimShape,
} from '../search/verbatim-routing';
import { detectOrderingShape } from './answer-router';

/**
 * Evidence-lane activation gates, split out of synthesize.service.ts
 * (max-lines budget). Pure predicates over the resolved profile + the
 * query/lane — no IO, no DI.
 */

/**
 * Verbatim-evidence activation per the profile's mode: 'always' runs
 * the L0 quote lanes on every question; 'shape_conditioned' (the
 * engine default) only when the question asks for ASSISTANT-side
 * content — extraction is user-fact-shaped and the measured SSA
 * failure is "facts do not specify…" while the verbatim turn sits
 * unused in L0; 'off' never. 'fused' behaves like shape_conditioned
 * for the two episode quote lanes — segments arrive as first-class
 * SearchHits from the retrieval-side fusion leg (audit W4 #18), so the
 * appendix segment lane deliberately does NOT run.
 */
export function wantsVerbatimEvidence(
  profile: RetrievalProfile,
  query: string,
): boolean {
  // 'routed' resolves per query (never to 'always'/'off'), so both of
  // its regimes take the shape-conditioned quote gate below — same as
  // 'fused'. Branch on the RESOLVED mode by invariant (answer-router).
  const mode = resolveVerbatimMode(profile.verbatimEvidence, query);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return detectVerbatimShape(query);
}

/**
 * Insight-lane activation (V8 §1): only under insightEvidence='routed'
 * and only for the question classes where derived insights measured as
 * paying — summarization / progressive-narrative (the summary lane)
 * and enumeration. Pointwise asks (no lane, or any other lane) skip
 * the slot: the V6 lesson generalized — every evidence class pays on
 * its own question class and drowns others; dispatch is the
 * mechanism, not always-on.
 */
export function wantsInsightEvidence(
  profile: RetrievalProfile,
  lane: LaneId | null,
): boolean {
  if (profile.insightEvidence !== 'routed') return false;
  return lane === 'summary' || lane === 'enumeration';
}

/**
 * Timeline-evidence activation (V8 §2): ordering/sequence-shaped
 * questions get the chronological segment appendix — the occurredAt-
 * ordered mention record. Facts cannot answer mention-order questions
 * (event-time extraction collapses a session's mentions onto one
 * validFrom date). Skipped when this query's resolved verbatim mode is
 * 'fused' — segments already arrive as scored hits and the appendix
 * would duplicate them. Under 'scan' (V9 §2) the same dispatch fires,
 * but the record is built by the mention-scan lane (coverage-first
 * topic scan, one line per session) instead of the top-K appendix.
 */
export function wantsTimelineEvidence(
  profile: RetrievalProfile,
  query: string,
): boolean {
  if (
    profile.timelineEvidence !== 'routed' &&
    profile.timelineEvidence !== 'scan'
  ) {
    return false;
  }
  if (!detectOrderingShape(query)) return false;
  return resolveVerbatimMode(profile.verbatimEvidence, query) !== 'fused';
}
