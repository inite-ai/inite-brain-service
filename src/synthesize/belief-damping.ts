import type { CitableBelief } from './belief-citations';
import { lineFactId, type Citation } from './fact-index';
import { applyFactSuffixes } from './update-story';

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
 * normalization, belief.subject equals the fact's canonicalName AND the
 * belief's SLOT equals the fact's; the line is CONTRADICTED only when
 * the normalized values then DIFFER (equal value ⇒ the fact agrees with
 * the current state ⇒ untouched). Subject matching rides the lane's
 * existing free-text subject key — no entity resolution, no similarity.
 *
 * THE SLOT IS WHY THIS PASS CAN FIRE AT ALL. It used to compare
 * `belief.field` with `fact.predicate` as strings, and the two planes
 * named attributes in two different languages: the fact plane in
 * registry ids (`deploy_target`), the belief plane in whatever the scene
 * enricher wrote (`deployment target`). Measured on a live tenant, ZERO
 * of 12 beliefs matched any of 163 distinct fact (subject, predicate)
 * keys — so the pass was structurally incapable of damping anything, and
 * reported exactly that: 69 clean, 0 damped. Since 0147 a belief carries
 * `(predicateAlias ?? predicateId)`, the same identity a fact carries,
 * and the join is id to id. A belief written before 0147 has no slot and
 * simply does not join — the behaviour it already had.
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
  countBeliefDamping(outcome: 'damped' | 'clean' | 'stale_belief', n?: number): void;
}

/** Trim + lowercase — the ONLY normalization the pass applies. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** (subject, slot) → belief key; NUL-joined so a '|' inside a free-text
 *  key can never alias two different keys onto one map slot. */
function beliefKey(subject: string, slot: string): string {
  return `${norm(subject)}\u0000${norm(slot)}`;
}

/** The slot a belief occupies, or '' when it predates 0147. */
function beliefSlot(belief: CitableBelief): string {
  return norm(belief.predicateId ?? '');
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
}): { factLines: string[]; staleBeliefIds: ReadonlySet<string> } {
  const { enabled, factLines, factIndex, beliefsById, metrics } = opts;
  const stale = new Set<string>();
  if (!enabled || !beliefsById || beliefsById.size === 0) {
    return { factLines: [...factLines], staleBeliefIds: stale };
  }
  const byKey = new Map<string, CitableBelief>();
  for (const belief of beliefsById.values()) {
    const slot = beliefSlot(belief);
    if (slot === '') continue; // pre-0147 row: no slot, no join
    const key = beliefKey(belief.subject, slot);
    if (!byKey.has(key)) byKey.set(key, belief);
  }
  if (byKey.size === 0) return { factLines: [...factLines], staleBeliefIds: stale };
  const kept: string[] = [];
  const damped: string[] = [];
  for (const line of factLines) {
    const found = contradictingBelief(line, factIndex, byKey);
    if (!found) {
      kept.push(line);
    } else if (factIsNewerThanBelief(found.fact, found.belief)) {
      // The fact outdates the belief's revision: the belief is the stale
      // side, the fact stands as written.
      stale.add(found.belief.beliefId);
      kept.push(line);
    } else {
      damped.push(
        `${line} (superseded by current belief: ${found.belief.field.trim()} = ${found.belief.value.trim()})`,
      );
    }
  }
  if (stale.size > 0) metrics?.countBeliefDamping('stale_belief', stale.size);
  if (damped.length === 0) {
    metrics?.countBeliefDamping('clean');
    return { factLines: kept, staleBeliefIds: stale };
  }
  metrics?.countBeliefDamping('damped', damped.length);
  return { factLines: [...kept, ...damped], staleBeliefIds: stale };
}

/**
 * TIME IS THE ARBITER BETWEEN THE TWO PLANES. A belief is DERIVED — a
 * scheduled pass distils it from settled scenes — while a fact is
 * written the moment a turn is ingested, so on the same slot the belief
 * can lag the fact plane by a whole revision. Read the two by what each
 * claims about time: a belief's `occurredAt` is the day its revision
 * became current; a fact's `validFrom` is the day its value holds from.
 * When they disagree on a slot, the LATER statement is the current one:
 * a fact dated after the belief's revision means the belief is stale —
 * it leaves the prompt (`staleBeliefIds`) and the fact stands; otherwise
 * the belief is the current state and the fact the older value it
 * replaced, damped as before. Measured before this: STEV `s08` answered
 * "You currently live in Lisbon [semantic_belief:…]" over a fact dated
 * after the move to Porto — the header told the generator the belief
 * supersedes the facts, and the pass demoted the newer fact under the
 * older belief. Undated on either side ⇒ the belief keeps precedence.
 */
function factIsNewerThanBelief(fact: Citation, belief: CitableBelief): boolean {
  const f = fact.validFrom ? Date.parse(fact.validFrom) : NaN;
  const b = belief.occurredAt ? Date.parse(belief.occurredAt) : NaN;
  return Number.isFinite(f) && Number.isFinite(b) && f > b;
}

/**
 * The rendered belief section without the beliefs a newer fact
 * outdated: the lines (headed `[<beliefId>] …`) and the citable map,
 * filtered together so the generator, the auditor and the citation
 * resolver agree on what was shown. Empty stale set ⇒ the inputs, as is.
 */
function withoutStaleBeliefs<
  T extends {
    beliefLines?: string[] | undefined;
    beliefsById?: ReadonlyMap<string, CitableBelief> | undefined;
  },
>(collected: T, staleBeliefIds: ReadonlySet<string>): T {
  if (staleBeliefIds.size === 0) return collected;
  const idOf = (line: string): string => {
    const close = line.indexOf(']');
    return line.startsWith('[') && close > 1 ? line.slice(1, close) : '';
  };
  const beliefLines = (collected.beliefLines ?? []).filter((l) => !staleBeliefIds.has(idOf(l)));
  const beliefsById = collected.beliefsById
    ? new Map([...collected.beliefsById].filter(([id]) => !staleBeliefIds.has(id)))
    : undefined;
  return {
    ...collected,
    beliefLines,
    // An emptied map is the "nothing rendered" state (the lane's own
    // fence semantics), so citations of a vanished section cannot resolve.
    beliefsById: beliefsById && beliefsById.size > 0 ? beliefsById : undefined,
  };
}

/** The matched belief that contradicts this fact line, with the fact,
 *  or null: same normalized (subject=canonicalName, slot) key, DIFFERENT
 *  normalized value. Unparsable/unindexed lines never dampen. */
function contradictingBelief(
  line: string,
  factIndex: ReadonlyMap<string, Citation>,
  byKey: ReadonlyMap<string, CitableBelief>,
): { fact: Citation; belief: CitableBelief } | null {
  const id = lineFactId(line, factIndex);
  const fact = id ? factIndex.get(id) : undefined;
  if (!fact) return null;
  const belief = byKey.get(beliefKey(fact.canonicalName, fact.slot));
  if (!belief) return null;
  return norm(belief.value) !== norm(fact.object) ? { fact, belief } : null;
}

/**
 * Round 1's one computation of the prompt fact lines AND the belief
 * section they are read beside: the suffix maps, the time-arbitrated
 * damping pass, and the belief section without the beliefs a newer fact
 * outdated — returned together so the orchestrator hands every consumer
 * (cache snapshot, generator, auditor, citation resolver, L3) one
 * consistent pair.
 */
export function arbitrateBeliefsAndFacts<
  T extends {
    beliefLines?: string[] | undefined;
    beliefsById?: ReadonlyMap<string, CitableBelief> | undefined;
    updateStories?: Map<string, string> | undefined;
    groundingQuotes?: Map<string, string> | undefined;
  },
>(opts: {
  enabled: boolean;
  factLines: readonly string[];
  factIndex: ReadonlyMap<string, Citation>;
  collected: T;
  metrics?: BeliefDampingMetrics | undefined;
}): { factLines: string[]; collected: T } {
  const { collected } = opts;
  const damping = applyBeliefFactDamping({
    enabled: opts.enabled,
    factLines: applyFactSuffixes(
      [...opts.factLines],
      [collected.updateStories, collected.groundingQuotes],
      opts.factIndex,
    ),
    factIndex: opts.factIndex,
    beliefsById: collected.beliefsById,
    metrics: opts.metrics,
  });
  return {
    factLines: damping.factLines,
    collected: withoutStaleBeliefs(collected, damping.staleBeliefIds),
  };
}
