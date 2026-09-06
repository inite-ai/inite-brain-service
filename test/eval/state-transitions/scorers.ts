/**
 * Mechanical scorers of the state-transition battery. Pure functions
 * over plain JSON — no HTTP, no LLM judge — unit-tested on fixtures in
 * test/state-transition-scorers.unit-spec.ts, so every verdict is
 * reproducible from the report file.
 *
 * Generic primitives (containsAnyOf / findForbidden / isAbstention /
 * walkProvenance / classifyConflictAnswer) are REUSED from the sibling
 * harness (test/eval/memory-fitness/scorers.ts) — one implementation,
 * one unit-tested truth. This file adds only what state transitions
 * need: the belief matcher, the N-stage history subsequence, and the
 * marker-first serve verdict.
 */
import {
  classifyConflictAnswer,
  containsAnyOf,
  findForbidden,
  isAbstention,
} from '../memory-fitness/scorers';
import type { BeliefCheck, ServeCheck } from './types';

export interface Verdict {
  pass: boolean;
  detail: string;
}

// ── belief matcher ──────────────────────────────────────────────────

/** The belief fields the matcher consumes (subset of BeliefReadResponse). */
export interface BeliefLike {
  subject: string;
  field: string;
  value: string;
  priorValue?: string;
  revision?: number;
}

const describeBelief = (b: BeliefLike): string =>
  `(${b.subject}, ${b.field}) value="${b.value}"` +
  (b.priorValue !== undefined ? ` prior="${b.priorValue}"` : ' prior=absent') +
  (b.revision !== undefined ? ` rev=${b.revision}` : '');

/**
 * Belief check: among the beliefs whose free-text (subject, field) key
 * matches the token filters, at least one satisfies every declared
 * constraint (value markers, prior markers / prior absence, minimum
 * revision). Token filters are anyOf-substring because the (subject,
 * field) key is enrichment-authored free text, not a fixed vocabulary.
 * A fail names the closest candidate so the report is diagnosable.
 */
export function checkBelief(
  beliefs: readonly BeliefLike[],
  spec: Pick<
    BeliefCheck,
    | 'subjectTokens'
    | 'fieldTokens'
    | 'valueMarkers'
    | 'priorMarkers'
    | 'priorAbsent'
    | 'minRevision'
  >,
): Verdict {
  const candidates = beliefs.filter(
    (b) => containsAnyOf(b.subject, spec.subjectTokens) && containsAnyOf(b.field, spec.fieldTokens),
  );
  if (candidates.length === 0) {
    return {
      pass: false,
      detail:
        `no belief matches subject~[${spec.subjectTokens.join('|')}] ` +
        `field~[${spec.fieldTokens.join('|')}] among ${beliefs.length} read`,
    };
  }
  for (const b of candidates) {
    if (spec.valueMarkers !== undefined && !containsAnyOf(b.value, spec.valueMarkers)) continue;
    if (spec.priorMarkers !== undefined) {
      if (b.priorValue === undefined) continue;
      if (!containsAnyOf(b.priorValue, spec.priorMarkers)) continue;
    }
    if (spec.priorAbsent === true && b.priorValue !== undefined) continue;
    if (spec.minRevision !== undefined && (b.revision ?? 0) < spec.minRevision) continue;
    return { pass: true, detail: `belief ${describeBelief(b)} satisfies every constraint` };
  }
  const closest = candidates[0];
  return {
    pass: false,
    detail:
      `${candidates.length} candidate belief(s) matched the key but none the constraints; ` +
      `closest: ${closest !== undefined ? describeBelief(closest) : '(none)'}`,
  };
}

// ── fact-history subsequence ────────────────────────────────────────

/** One timeline event as the history checker consumes it. */
export interface HistoryEvent {
  predicate: string;
  object: string;
  /** ISO timestamp the event was recorded at. */
  at: string;
}

export interface HistoryVerdict extends Verdict {
  /** How many stages were consumed — lets the runner keep the best fail. */
  matchedStages: number;
}

/**
 * N-stage history check (generalised from the sibling's checkEvolution):
 * the timeline must contain, as a chronological SUBSEQUENCE of
 * fact.recorded events, one event per stage in stage order. Matching is
 * greedy over the sorted events and a stage marker is matched against
 * the combined `${predicate} ${object}` text, because mention-extracted
 * predicates are LLM-worded and cannot be pinned exactly.
 *
 * Greedy subsequence (not first-match-per-stage) avoids the false fail
 * where a late stage's marker also matches an early event: each stage
 * only scans events AFTER its predecessor's match.
 */
export function checkHistorySequence(
  events: readonly HistoryEvent[],
  stages: ReadonlyArray<readonly string[]>,
): HistoryVerdict {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const matched: string[] = [];
  let cursor = 0;
  for (const [i, stage] of stages.entries()) {
    let found = false;
    while (cursor < sorted.length) {
      const ev = sorted[cursor];
      cursor += 1;
      if (ev !== undefined && containsAnyOf(`${ev.predicate} ${ev.object}`, stage)) {
        matched.push(`${ev.predicate}="${ev.object}"@${ev.at}`);
        found = true;
        break;
      }
    }
    if (!found) {
      return {
        pass: false,
        matchedStages: i,
        detail:
          `stage ${i + 1}/${stages.length} [${stage.join('|')}] not found after ` +
          `${matched.length > 0 ? matched[matched.length - 1] : 'start'} ` +
          `(${sorted.length} recorded events scanned)`,
      };
    }
  }
  return {
    pass: true,
    matchedStages: stages.length,
    detail: `history retains all ${stages.length} stages in order: ${matched.join(' -> ')}`,
  };
}

// ── serve verdict ───────────────────────────────────────────────────

export interface ServeVerdict {
  status: 'pass' | 'fail';
  detail: string;
}

/**
 * Serve check verdict. Semantics, in order:
 *
 *  1. conflict mode — classifyConflictAnswer: both-sides or abstained
 *     pass; one-sided / neither fail (scenario 7);
 *  2. expectAbstain — pass iff the answer is an abstention;
 *  3. forbidden markers — any hit fails FIRST (an answer naming both
 *     the current and the forbidden value is a stale leak, sibling D1);
 *  4. expect markers — pass on ≥1 hit. Deliberately checked BEFORE the
 *     abstention detector: the honest answer to a disposal question
 *     ("you don't have a bike anymore — you sold it") trips the shared
 *     decline regex, so abstention alone must not fail a serve whose
 *     expected truth IS a negation. Expect markers are authored to
 *     never occur in decline phrasings ('sold', 'no longer', 'not own'
 *     — never bare 'no' / 'do not', which decline answers contain).
 */
export function scoreServe(
  answer: string | null | undefined,
  reason: string | undefined,
  spec: Pick<ServeCheck, 'expectAnyOf' | 'forbidAnyOf' | 'expectAbstain' | 'conflictSides'>,
): ServeVerdict {
  if (spec.conflictSides !== undefined) {
    const verdict = classifyConflictAnswer(
      answer,
      spec.conflictSides.sideA,
      spec.conflictSides.sideB,
      reason,
    );
    switch (verdict) {
      case 'both-sides':
        return { status: 'pass', detail: 'answer names both sides of the conflict' };
      case 'abstained':
        return { status: 'pass', detail: 'abstained rather than pick a side silently' };
      case 'one-sided':
        return { status: 'fail', detail: 'served one side of a live conflict' };
      case 'neither':
        return { status: 'fail', detail: 'answer names neither side' };
    }
  }
  if (spec.expectAbstain === true) {
    return isAbstention(answer, reason)
      ? { status: 'pass', detail: 'honest abstention' }
      : { status: 'fail', detail: 'expected abstention, got an answer' };
  }
  const text = answer ?? '';
  const forbidden = findForbidden(text, spec.forbidAnyOf ?? []);
  if (forbidden !== null) {
    return { status: 'fail', detail: `forbidden marker served: "${forbidden}"` };
  }
  const expected = spec.expectAnyOf === undefined || containsAnyOf(text, spec.expectAnyOf);
  if (expected) {
    return { status: 'pass', detail: 'current-state marker served, no forbidden marker' };
  }
  if (isAbstention(answer, reason)) {
    return { status: 'fail', detail: 'abstained on a known state' };
  }
  return {
    status: 'fail',
    detail: `expected one of [${(spec.expectAnyOf ?? []).join(', ')}]`,
  };
}
