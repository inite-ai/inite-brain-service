import type { ExtractedEntity, ExtractedFact } from './types';
import { normalizeForGrounding } from './grounding';
import { sentenceAt, sentenceSpans } from './literal-harvest';

/**
 * Deterministic state-verb harvest lane (EXTRACTOR_STATE_VERB_HARVEST)
 * — sibling of the literal-harvest lane, targeting the measured
 * state-transition drop.
 *
 * The state-transition battery (test/eval/state-transitions, 2 live
 * runs) showed transition VERBS dying in the closed-vocab extractor:
 * "I quit the chess club today", "Returned the standing desk by
 * evening" produce NO fact carrying the transition, so
 * get_entity_timeline history checks fail (fact-history 0/3) and
 * re-acquire / same-day scenarios break. The CRM seed vocabulary has
 * no slot for membership/possession events; the model emits a
 * transition only when the turn ALSO restates the state explicitly.
 *
 * This module is the deterministic complement: a fixed transition
 * lexicon (past-tense / completed forms only) over the trimmed input,
 * each match producing ONE span-grounded `state_change` fact whose
 * object and valueSpan are the exact matched verb-phrase substring of
 * the input BY CONSTRUCTION — so the grounding invariant holds without
 * a second gate pass. Pure code, no LLM call, no prompt change (the
 * rollback precedent for prompt nudging: agent-qa 47.4→42.1).
 *
 * Intention guards keep voiced plans out: "thinking about selling",
 * "will quit", "haven't sold" harvest NOTHING (battery scenario s05,
 * the intention-not-action guard, must not flip). Gerunds are excluded
 * by construction — the lexicon carries completed forms only — and
 * 'listed' is deliberately NOT in the lexicon: listing something for
 * sale is not a possession transition (battery scenario s06).
 */

/** Confidence stamped on every harvested fact — deterministic match. */
export const STATE_VERB_HARVEST_CONFIDENCE = 0.95;

/** Max harvested facts per turn — bounds pathological inputs. */
export const STATE_VERB_HARVEST_CAP = 6;

/** The single predicate every harvested transition lands under. */
export const STATE_CHANGE_PREDICATE = 'state_change';

/**
 * Transition lexicon — past-tense / completed forms ONLY, so gerunds
 * ("selling") and infinitives ("to sell") never match by construction.
 * Multi-word verbs are single lexicon entries ("signed up for") so the
 * harvested span carries the full phrasal verb.
 */
const ACQUIRE_VERBS = [
  'bought',
  'adopted',
  'joined',
  'rejoined',
  'signed up for',
  'subscribed to',
  'started',
  'opened',
  'hired',
  'acquired',
  'got',
];

const DISPOSE_VERBS = [
  'sold',
  'quit',
  'left',
  'returned',
  'cancelled',
  'unsubscribed from',
  'stopped',
  'ended',
  'closed',
  'gave away',
  'gave up',
  'lost',
  'fired',
  'dropped',
];

/**
 * Change-class verbs. `replaced` is a deliberate addition to the
 * design's moved/switched/renamed/migrated set: the battery's own
 * replace scenario (s02) words the transition "I replaced my laptop
 * today" — none of the four `… to` forms appears in that turn, and a
 * change-class that misses the corpus's canonical replace sentence
 * would ship untestable.
 */
const CHANGE_VERBS = ['moved to', 'switched to', 'renamed to', 'migrated to', 'replaced'];

/**
 * Coding-domain transition verbs (code-memory dogfood program,
 * 2026-09): the consumer-life lexicon above harvests nothing from a
 * coding agent's narration — "we enabled ACME_RETRY_QUEUE in prod",
 * "merged PR #431", "bumped jest to 30" all died in the closed-vocab
 * extractor exactly like the consumer transitions did. Additions only;
 * the existing lexicon, guards and holder binding are untouched.
 *
 * Matcher constraints these forms respect BY CONSTRUCTION:
 *  - completed forms only, so "enabling" / "to deprecate" never match;
 *  - multi-word entries must be ADJACENT in the input ("rolled back
 *    the migration" matches; "rolled the migration back" does not —
 *    split phrasal particles are outside the matcher's model);
 *  - a verb with an empty object noun phrase harvests nothing, so
 *    passive / verb-final phrasings ("PR #431 was merged.", "the flag
 *    was enabled.") produce NO fact rather than a mis-bound one;
 *  - the object capture stops at any clause-boundary character and
 *    "." is one, so a dotted value in the object ("upgraded SurrealDB
 *    to 3.2.4") clips at its first dot ("upgraded SurrealDB to 3") —
 *    still harvested, still verbatim, just truncated;
 *  - bare "renamed" / "migrated" coexist with the consumer "renamed
 *    to" / "migrated to": ALL_VERBS sorts longest-first, so the
 *    phrasal form still wins whenever it is present.
 *
 * Holder binding is inherited unchanged: bindStateHolder routes the
 * fact to a PERSON entity named in the sentence, else the speaker — so
 * an active-voice artifact transition ("we enabled FLAG_X") lands on
 * the AGENT, not on the flag entity. Known limitation, deliberate for
 * this small PR; the code-memory battery measures it.
 */
const CODING_VERBS = [
  'merged',
  'reverted',
  'enabled',
  'disabled',
  'deployed',
  'released',
  'bumped',
  'upgraded',
  'downgraded',
  'deprecated',
  'removed',
  'deleted',
  'renamed',
  'migrated',
  'rolled back',
];

/** All verbs, longest-first so phrasal forms win over any prefix form. */
const ALL_VERBS = [...ACQUIRE_VERBS, ...DISPOSE_VERBS, ...CHANGE_VERBS, ...CODING_VERBS].sort(
  (a, b) => b.length - a.length,
);

/** Word-boundary-matched, case-insensitive alternation over the lexicon. */
const TRANSITION_VERB = new RegExp(`\\b(?:${ALL_VERBS.join('|')})\\b`, 'gi');

/**
 * Clause boundary for BOTH the object capture (forward) and the guard
 * window (backward): comma, semicolon, colon, sentence punctuation,
 * em/en dash, a SPACED ascii dash (an intra-word hyphen as in
 * "ledger-sync" must not split), and the subordinators. The colon is a
 * deliberate addition to the design's boundary list — the corpus's own
 * replace turn pivots on one ("I replaced my laptop today: …") and an
 * unbounded capture would drag the next clause into the span.
 */
const CLAUSE_BOUNDARY_SOURCE = String.raw`[,;:.!?—–]|\s--?\s|\s(?:because|when|so|but)\s`;
/** Global form — backward scan for the LAST boundary before the verb. */
const CLAUSE_BOUNDARY_ALL = new RegExp(CLAUSE_BOUNDARY_SOURCE, 'gi');
/** Non-global form — forward search for the FIRST boundary after it. */
const CLAUSE_BOUNDARY_FIRST = new RegExp(CLAUSE_BOUNDARY_SOURCE, 'i');

/**
 * Pre-verb guard terms: a match is skipped when any of these occurs
 * within the 6 tokens before the verb in the same clause. Negation
 * ("haven't sold"), hypotheticals ("might", "could"), futures ("will
 * quit"), and intention idioms ("thinking about", "planning to") all
 * mean the transition did NOT complete — harvesting them would flip
 * state on a voiced plan (the exact s05 failure this guard exists for).
 */
const GUARD_TERMS = [
  'not',
  'never',
  "haven't",
  "hasn't",
  "hadn't",
  "won't",
  "wouldn't",
  'without',
  'thinking about',
  'thinking of',
  'planning to',
  'plan to',
  'considering',
  'might',
  'may',
  'could',
  'want to',
  'wants to',
  'hoping to',
  'about to',
  'going to',
  'will',
  'intend',
  'intends',
];

const GUARD_PATTERN = new RegExp(`\\b(?:${GUARD_TERMS.join('|')})\\b`, 'i');

/** Guard window: tokens inspected before the verb (same clause). */
const GUARD_WINDOW_TOKENS = 6;

/** Object-capture caps: token run after the verb. */
const OBJECT_MAX_TOKENS = 8;
const OBJECT_MAX_CHARS = 60;

/**
 * `got` is the polysemous verb of the lexicon ("got busy", "got home",
 * "got married" are not possession transitions). It only fires when
 * its object opens with a determiner / possessive / numeral — "got a
 * company car" harvests, "got too busy at work" does not.
 */
const GOT_OBJECT_GATE = /^(?:a|an|the|my|our|his|her|their|its|another|some|\d+)$/i;

/**
 * True when the 6-token pre-verb window (clipped to the clause the
 * verb sits in) carries a guard term. Typographic apostrophes are
 * folded to ASCII so "haven’t" guards like "haven't".
 */
function guardedBefore(input: string, sentenceStart: number, verbStart: number): boolean {
  const pre = input.slice(sentenceStart, verbStart);
  // Clip to the verb's own clause: guards in a PREVIOUS clause do not
  // scope over the verb ("I did not go out; I joined the chess club").
  let clauseFrom = 0;
  for (const b of pre.matchAll(CLAUSE_BOUNDARY_ALL)) {
    clauseFrom = b.index + b[0].length;
  }
  const window = pre
    .slice(clauseFrom)
    .replace(/’/g, "'")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(-GUARD_WINDOW_TOKENS)
    .join(' ');
  return window.length > 0 && GUARD_PATTERN.test(window);
}

/**
 * End offset (absolute) of the object token run after the verb: tokens
 * up to the first clause boundary, capped at OBJECT_MAX_TOKENS /
 * OBJECT_MAX_CHARS. Returns null when the run is empty — a bare verb
 * with no object noun phrase harvests nothing ("The chapter is
 * closed;" must not produce a fact).
 */
function objectEnd(input: string, verbEnd: number): { end: number; firstToken: string } | null {
  const rest = input.slice(verbEnd);
  const boundaryIdx = rest.search(CLAUSE_BOUNDARY_FIRST);
  const raw = boundaryIdx === -1 ? rest : rest.slice(0, boundaryIdx);
  let end = -1;
  let firstToken = '';
  let tokens = 0;
  for (const t of raw.matchAll(/\S+/g)) {
    if (tokens >= OBJECT_MAX_TOKENS) break;
    const tokenEnd = t.index + t[0].length;
    if (raw.slice(0, tokenEnd).trim().length > OBJECT_MAX_CHARS) break;
    if (tokens === 0) firstToken = t[0];
    end = tokenEnd;
    tokens++;
  }
  if (end <= 0) return null;
  return { end: verbEnd + end, firstToken };
}

export interface HarvestStateVerbsArgs {
  /** The clamped input text the extraction ran on. */
  trimmed: string;
  /** The FINAL compacted grounded entity list of the extraction. */
  entities: ExtractedEntity[];
  /** Speaker's index in `entities` (resolveSpeakerEntityIndex), or null. */
  speakerEntityIndex: number | null;
  /** Denoised LLM facts (+ any prior harvest lane) — drives dedup. */
  existingFacts?: readonly ExtractedFact[];
}

/**
 * Harvest completed state transitions from the trimmed input as
 * span-grounded `state_change` facts. Mirrors harvestLiterals:
 * `existingFacts` drives dedup — a harvested fact whose (entityIndex,
 * predicate, normalized object) triple already exists is skipped —
 * entity binding is clause-overlap with speaker fallback, and the
 * output is capped at STATE_VERB_HARVEST_CAP. Returns ONLY the new
 * facts for the caller to union.
 */
/**
 * Bind a transition to its STATE HOLDER, not to the transitioned object.
 *
 * A state_change is a fact about whoever's world-state changed — the
 * person who sold/joined/returned — never about the asset or club named
 * in the clause. The literal lane's `bindEntity` (first name-overlap
 * win) is wrong here: it scatters a multi-stage transition across
 * object entities ("chess club" vs "the chess club", "standing desk"
 * vs "standing desk trial" — live run stmtp52jfw), so no single
 * timeline retains the sequence. Policy: a PERSON entity (customer |
 * staff) named in the sentence wins (third-party transitions — "Boris
 * returned the company car" binds to Boris), else the speaker. Object
 * entities are deliberately never bound; the object is already inside
 * the harvested span.
 *
 * Exported for the transition-classifier lane (transition-harvest.ts):
 * both transition lanes MUST bind identically or a multi-stage
 * transition harvested half by each lane scatters across timelines —
 * the exact stmtp52jfw failure this binder exists to prevent.
 */
export function bindStateHolder(
  entities: ExtractedEntity[],
  sentenceText: string,
  speakerEntityIndex: number | null,
): number | null {
  const sentenceLower = sentenceText.toLowerCase();
  for (const [i, e] of entities.entries()) {
    if (e.type !== 'customer' && e.type !== 'staff') continue;
    const name = e.name.trim().toLowerCase();
    if (name && sentenceLower.includes(name)) return i;
  }
  return speakerEntityIndex;
}

export function harvestStateVerbs(args: HarvestStateVerbsArgs): ExtractedFact[] {
  const { trimmed, entities, speakerEntityIndex, existingFacts = [] } = args;
  if (!trimmed || entities.length === 0) return [];
  const sentences = sentenceSpans(trimmed);
  const seen = new Set(
    existingFacts.map(
      (f) => `${f.entityIndex}\u0000${f.predicate}\u0000${normalizeForGrounding(f.object)}`,
    ),
  );
  const harvested: ExtractedFact[] = [];
  for (const m of trimmed.matchAll(TRANSITION_VERB)) {
    if (harvested.length >= STATE_VERB_HARVEST_CAP) break;
    const sentence = sentenceAt(sentences, m.index);
    if (guardedBefore(trimmed, sentence.start, m.index)) continue;
    const object = objectEnd(trimmed, m.index + m[0].length);
    if (!object) continue;
    if (m[0].toLowerCase() === 'got' && !GOT_OBJECT_GATE.test(object.firstToken)) continue;
    // The harvested value is the exact matched span VERB INCLUDED
    // ("quit the chess club today") — a verbatim substring of the
    // input, so valueSpan === object and the grounding gate passes by
    // construction.
    const span = trimmed.slice(m.index, object.end);
    const entityIndex = bindStateHolder(entities, sentence.text, speakerEntityIndex);
    if (entityIndex === null) continue;
    const key = `${entityIndex}\u0000${STATE_CHANGE_PREDICATE}\u0000${normalizeForGrounding(span)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    harvested.push({
      entityIndex,
      predicate: STATE_CHANGE_PREDICATE,
      object: span,
      confidence: STATE_VERB_HARVEST_CONFIDENCE,
      clause: sentence.text.trim(),
      valueSpan: span,
    });
  }
  return harvested;
}
