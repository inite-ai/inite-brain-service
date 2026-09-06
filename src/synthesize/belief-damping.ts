import type { CitableBelief } from './belief-citations';
import type { Citation } from './fact-index';

/**
 * Belief-aware fact damping (BELIEFS_FACT_DAMPING, PR-B — the serving
 * lane's companion pass). Pure: no IO, no DI, no env — the update-story
 * module's contract, one seam over.
 *
 * WHAT IT DOES: after the fact-line suffix maps apply, the pass marks
 * and demotes every fact line that a lane-matched CURRENT belief
 * contradicts, so a superseded fact stops outranking the current state
 * it lost to. A contradicted line gets
 *   (a) the deterministic suffix
 *       ` (superseded by current belief: <field> = <value>)`, and
 *   (b) a STABLE demotion — moved after the non-contradicted lines,
 *       preserving relative order within each group (a stable
 *       partition, never a re-sort by any score).
 * Belief lines themselves are untouched — this pass only ever sees the
 * fact section.
 *
 * CONTRADICTION SEMANTICS (deliberately conservative — never fuzzy):
 * a matched belief covers a fact line when, after trim + lowercase
 * normalization, belief.subject equals the fact's canonicalName AND
 * belief.field equals the fact's predicate; the line is CONTRADICTED
 * only when the normalized values then DIFFER (equal value ⇒ the fact
 * agrees with the current state ⇒ untouched). Subject matching rides
 * the lane's existing free-text (subject, field) key — no entity
 * resolution, no similarity.
 *
 * THREE-CONSUMER PARITY BY CONSTRUCTION (the
 * BELIEFS_LANE_DATE_DISAMBIGUATION pattern): the pass runs at the ONE
 * canonical promptFactLines computation — immediately after
 * applyFactSuffixes, in both the round-1 site and the V13 refine-round
 * site — so the generator, the verifier and the fragment-zoom
 * re-verify all read the SAME damped lines (the L3 escalation reads
 * them too). The damping suffix therefore renders LAST on the line,
 * after the update-story and grounding-quote suffixes.
 *
 * FENCE: `beliefsById` is the lane's rendered-set map — ONLY beliefs
 * actually rendered into the prompt's current-state section (rows that
 * already passed the lane's tenant → scoped-user → active →
 * beliefVisible stack). Damping keys off it, so with the serving lane
 * off (or an unscoped request, or nothing matched) there ARE no
 * matched beliefs and the pass is a structural no-op — exactly the
 * boot-validation WARN's inconsistent-pair semantics.
 *
 * ORDERING CAVEAT (deliberate): demotion runs AFTER the profile's
 * chronological fact ordering, so a damped line leaves its
 * chronological slot — that is the point: the contradicted assertion
 * yields prompt position to lines the current state does not dispute.
 */

/** Metrics port (keeps this module pure — the belief-citations idiom). */
export interface BeliefDampingMetrics {
  countBeliefDamping(outcome: 'damped' | 'clean', n?: number): void;
}

/** Trim + lowercase — the ONLY normalization the pass applies. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** (subject, field) → belief key; NUL-joined so a '|' inside a free-text
 *  key can never alias two different keys onto one map slot. */
function beliefKey(subject: string, field: string): string {
  return `${norm(subject)}\u0000${norm(field)}`;
}

/**
 * Apply the damping pass to the finalized prompt fact lines.
 *
 * `enabled` is the caller-resolved BELIEFS_FACT_DAMPING (the
 * single-resolution idiom — resolved ONCE per request by the
 * orchestrator; this module reads no env). Disabled, or no matched
 * beliefs, or no contradiction ⇒ the returned array carries the exact
 * input strings in the exact input order (byte-identical prompts).
 *
 * Lines resolve to facts through the `[<factId>] ` prefix (the
 * appendUpdateStories idiom) against the caller's factIndex; a line
 * with no parsable prefix or no index entry is never damped.
 *
 * Metrics (emitted only when the pass actually evaluates — flag on AND
 * matched beliefs present; nothing on the path otherwise): `damped`
 * counts once PER demoted line (the countBeliefCitation per-entry
 * idiom), `clean` once per evaluation that demoted nothing. A refined
 * request (V13 search loop) evaluates the pass once per round.
 */
export function applyBeliefFactDamping(opts: {
  enabled: boolean;
  factLines: readonly string[];
  factIndex: ReadonlyMap<string, Citation>;
  beliefsById: ReadonlyMap<string, CitableBelief> | undefined;
  metrics?: BeliefDampingMetrics | undefined;
}): string[] {
  const { enabled, factLines, factIndex, beliefsById, metrics } = opts;
  if (!enabled || !beliefsById || beliefsById.size === 0) return [...factLines];
  // The lane dedupes by exact (subject, field); after normalization two
  // case-variant keys could collide — first rendered belief wins.
  const byKey = new Map<string, CitableBelief>();
  for (const belief of beliefsById.values()) {
    const key = beliefKey(belief.subject, belief.field);
    if (!byKey.has(key)) byKey.set(key, belief);
  }
  const kept: string[] = [];
  const damped: string[] = [];
  for (const line of factLines) {
    const belief = contradictingBelief(line, factIndex, byKey);
    if (belief) {
      damped.push(
        `${line} (superseded by current belief: ${belief.field.trim()} = ${belief.value.trim()})`,
      );
    } else {
      kept.push(line);
    }
  }
  if (damped.length === 0) {
    metrics?.countBeliefDamping('clean');
    return kept;
  }
  metrics?.countBeliefDamping('damped', damped.length);
  // Stable partition: both groups preserve their relative input order.
  return [...kept, ...damped];
}

/** The matched belief that contradicts this fact line, or null: same
 *  normalized (subject=canonicalName, field=predicate) key, DIFFERENT
 *  normalized value. Unparsable/unindexed lines never dampen. */
function contradictingBelief(
  line: string,
  factIndex: ReadonlyMap<string, Citation>,
  byKey: ReadonlyMap<string, CitableBelief>,
): CitableBelief | null {
  if (!line.startsWith('[')) return null;
  const close = line.indexOf(']');
  if (close <= 1) return null;
  const fact = factIndex.get(line.slice(1, close));
  if (!fact) return null;
  const belief = byKey.get(beliefKey(fact.canonicalName, fact.predicate));
  if (!belief) return null;
  return norm(belief.value) !== norm(fact.object) ? belief : null;
}
