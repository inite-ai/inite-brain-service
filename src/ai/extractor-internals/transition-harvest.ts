import type { ExtractedEntity, ExtractedFact } from './types';
import { normalizeForGrounding } from './grounding';
import { sentenceAt, sentenceSpans } from './literal-harvest';
import { findTransitionCandidates, isCompletedTransition } from './transition-morphology';
import {
  TRANSITION_MARGIN_DEFAULT,
  TRANSITION_SCORE_FLOOR,
  type TransitionClass,
  type TransitionClassifier,
} from './transition-classifier';
import { STATE_CHANGE_PREDICATE, bindStateHolder } from './state-verb-harvest';

/**
 * Transition-classifier harvest lane (EXTRACTOR_TRANSITION_CLASSIFIER,
 * the WIRING of the two-stage module built in #430) — the semantic
 * generalization of the deterministic state-verb lexicon lane
 * (state-verb-harvest.ts): out-of-lexicon verbs ("parted with",
 * "handed over"), morphology variants, and Russian input, all landing
 * as the SAME `state_change` fact shape at the same extraction seam.
 *
 * Pipeline per turn:
 *  1. candidates — English verb clauses from compromise morphology
 *     (findTransitionCandidates), kept only when isCompletedTransition
 *     holds: past-tense, non-negated, non-hypothetical, with a
 *     complement — the same intention/negation semantics the lexicon
 *     lane's pre-verb guards enforce, applied by grammar instead of a
 *     token window. Plus a bounded Russian candidate path (below) —
 *     compromise is English-only, but RU past tense is morphologically
 *     marked (-л/-ла/-ло/-ли), so a small deterministic matcher gives
 *     the multilingual classifier its RU candidates.
 *  2. defer-to-lexicon — a sentence that ALREADY carries a
 *     `state_change` fact in `existingFacts` (the lexicon lane runs
 *     first and stamps `clause` with the same sentenceSpans text) is
 *     skipped whole. The deterministic lexicon wins its sentences; the
 *     classifier only generalizes where the lexicon saw nothing —
 *     that is the composition contract from #430, and it makes
 *     double-emission structurally impossible.
 *  3. prototype match — surviving clauses go to the classifier as ONE
 *     batch; a clause is accepted only when the argmax class is a
 *     completed_* transition AND clears the calibrated score floor and
 *     runner-up margin. `intention` / `unrelated` verdicts and
 *     below-threshold verdicts harvest nothing (precision-first: a
 *     false state_change flips downstream beliefs; a miss costs one
 *     recall point).
 *  4. emission — same shape and invariants as the lexicon lane: the
 *     object/valueSpan is the candidate clause as a VERBATIM substring
 *     of the input (grounding holds by construction), the holder is
 *     bound via the shared bindStateHolder (person in sentence, else
 *     speaker), dedup by (entity, predicate, normalized object), and
 *     the output is capped.
 *
 * Pure module: no Nest/DI imports, no env reads, no LLM calls. The
 * classifier (and through it the embedder) is injected.
 */

/**
 * Confidence stamped on classifier-harvested facts. Deliberately below
 * the lexicon lane's 0.95: the lexicon is a deterministic match, this
 * is an embedding-space verdict that clears calibrated thresholds.
 */
export const TRANSITION_HARVEST_CONFIDENCE = 0.85;

/** Max harvested facts per turn — parity with the sibling lanes. */
export const TRANSITION_HARVEST_CAP = 6;

/**
 * Max candidate clauses embedded per turn — bounds pathological inputs
 * BEFORE the embed batch (the cap above only bounds emissions).
 */
export const TRANSITION_CANDIDATE_CAP = 12;

/** The verdict classes that may emit a fact. */
const ACCEPTED_CLASSES: ReadonlySet<TransitionClass> = new Set([
  'completed_acquire',
  'completed_dispose',
  'completed_change',
]);

/**
 * ── Russian candidate path ───────────────────────────────────────────
 *
 * compromise cannot analyze Russian, but the classifier's prototype
 * bank is EN+RU by construction (#430) — without a RU candidate source
 * the wired lane could never fire on the language the module was built
 * to generalize to. Russian past tense IS morphologically marked (the
 * -л suffix: продал / продала / вернули / переехал), so a candidate
 * sentence is detectable without any verb lexicon: a Cyrillic token
 * shaped like a past-tense verb, followed by complement material.
 *
 * Guards are SENTENCE-scoped and stricter than the English ones on
 * purpose (precision-first, and no parse to scope them tighter): any
 * negation particle, intention governor, or irrealis marker anywhere
 * in the sentence rejects the whole sentence. "Не буду врать: я продал
 * мотоцикл" is a deliberate miss, never a false flip. The copula
 * (был/была/было/были) never triggers a candidate — "У меня был
 * мотоцикл" is a state, not a transition. Non-verb -л tokens
 * ("мотоцикл", "стол") can still trigger; the classifier's floor and
 * class verdict are the backstop that keeps them out (measured in the
 * calibration sweep — see eval:transition-calibration).
 */
const RU_PAST_VERB = /(?<![\p{L}\p{N}_])([а-яё]+л(?:а|о|и)?(?:с[ья])?)(?![\p{L}\p{N}_])/giu;

/** Copula forms excluded as candidate triggers (with/without -ся). */
const RU_COPULA = new Set(['был', 'была', 'было', 'были']);

/**
 * Sentence-scoped RU guard: negation particles (не/ни/нет), the
 * irrealis particle (бы) and hedges (возможно/может/если/вряд),
 * and intention governors (хочу/собираюсь/планирую/думаю/подумываю/
 * мечтаю/надеюсь/рассматриваю + their past/gender forms via stems).
 */
const RU_GUARD =
  /(?<![\p{L}\p{N}_])(?:не|ни|нет|бы|возможно|может|если|вряд|хо(?:чу|чешь|чет|тим|тите|тят|тел[аио]?)|собира\p{L}*|планир\p{L}*|подумыва\p{L}*|дума(?:ю|ешь|ет|ем|ете|ют|л[аио]?)|мечта\p{L}*|наде\p{L}*|рассматрива\p{L}*)(?![\p{L}\p{N}_])/iu;

/** A word token (letters/digits) — complement material check. */
const RU_WORD_AFTER = /[\p{L}\p{N}]/u;

export interface HarvestCandidate {
  /** Clause text sent to the classifier. */
  clause: string;
  /** [start, end) of the clause in the input. */
  span: [number, number];
}

/**
 * RU candidates: at most ONE per sentence (the sentence itself is the
 * clause — no RU clause segmentation without a parser), only for
 * sentences that contain Cyrillic, pass the sentence-scoped guard, and
 * carry a past-tense-shaped non-copula token with material after it.
 */
function findRussianCandidates(
  trimmed: string,
  sentences: ReturnType<typeof sentenceSpans>,
): HarvestCandidate[] {
  const out: HarvestCandidate[] = [];
  for (const s of sentences) {
    if (!/[а-яё]/i.test(s.text)) continue;
    if (RU_GUARD.test(s.text)) continue;
    let hasVerb = false;
    for (const m of s.text.matchAll(RU_PAST_VERB)) {
      const token = (m[1] ?? '').toLowerCase();
      if (RU_COPULA.has(token)) continue;
      const rest = s.text.slice(m.index + m[0].length);
      if (!RU_WORD_AFTER.test(rest)) continue; // no complement material
      hasVerb = true;
      break;
    }
    if (hasVerb) out.push({ clause: s.text.trim(), span: [s.start, s.end] });
  }
  return out;
}

/**
 * The object emitted for a candidate: the clause as a verbatim
 * substring of the input, with surrounding whitespace and trailing
 * clause punctuation stripped (still a substring — only the ends are
 * trimmed, so the grounding invariant holds by construction).
 */
function clauseObject(trimmed: string, span: [number, number]): string {
  return trimmed
    .slice(span[0], span[1])
    .replace(/^[\s]+/u, '')
    .replace(/[\s.,;:!?—–]+$/u, '');
}

/**
 * The deterministic candidate stage of the lane, before any embedding:
 * English completed-transition clauses from compromise morphology plus
 * the bounded RU sentence candidates, deduped by clause span. Exported
 * so the calibration harness (eval:transition-calibration) sweeps the
 * EXACT candidate population the wired lane classifies — thresholds
 * calibrated over a different candidate stage would be fiction.
 */
export function findHarvestCandidates(trimmed: string): HarvestCandidate[] {
  if (!trimmed.trim()) return [];
  const sentences = sentenceSpans(trimmed);
  const candidates: HarvestCandidate[] = [];
  const seenSpans = new Set<string>();
  const push = (c: HarvestCandidate): void => {
    const key = `${c.span[0]}:${c.span[1]}`;
    if (seenSpans.has(key)) return; // one candidate per clause span
    seenSpans.add(key);
    candidates.push(c);
  };
  for (const c of findTransitionCandidates(trimmed)) {
    if (!isCompletedTransition(c)) continue;
    push({ clause: c.clause, span: c.span });
  }
  for (const c of findRussianCandidates(trimmed, sentences)) push(c);
  return candidates;
}

export interface HarvestTransitionsArgs {
  /** The clamped input text the extraction ran on. */
  trimmed: string;
  /** The FINAL compacted grounded entity list of the extraction. */
  entities: ExtractedEntity[];
  /** Speaker's index in `entities` (resolveSpeakerEntityIndex), or null. */
  speakerEntityIndex: number | null;
  /**
   * Denoised LLM facts + prior harvest lanes (literal, state-verb) —
   * drives BOTH the defer-to-lexicon rule and the triple dedup.
   */
  existingFacts?: readonly ExtractedFact[];
  /** The prototype classifier (embedder already bound). */
  classifier: TransitionClassifier;
  /** Calibrated gates; default to the module's exported constants. */
  scoreFloor?: number;
  margin?: number;
}

/**
 * Harvest completed state transitions via morphology + prototype
 * classification, as span-grounded `state_change` facts. Async because
 * the classifier embeds; the ONLY awaited call is one classify() batch
 * (which itself is at most two embed batches), and it is skipped
 * entirely when no candidate survives the deterministic stages.
 * Returns ONLY the new facts for the caller to union.
 */
export async function harvestTransitions(args: HarvestTransitionsArgs): Promise<ExtractedFact[]> {
  const {
    trimmed,
    entities,
    speakerEntityIndex,
    existingFacts = [],
    classifier,
    scoreFloor = TRANSITION_SCORE_FLOOR,
    margin = TRANSITION_MARGIN_DEFAULT,
  } = args;
  if (!trimmed || entities.length === 0) return [];
  const sentences = sentenceSpans(trimmed);

  // Sentences already carrying a state_change fact (lexicon lane or a
  // prior LLM fact anchored to the same sentence) — deferred whole.
  const claimedSentences = new Set(
    existingFacts
      .filter((f) => f.predicate === STATE_CHANGE_PREDICATE && f.clause)
      .map((f) => (f.clause as string).trim()),
  );

  const candidates = findHarvestCandidates(trimmed).filter(
    (c) => !claimedSentences.has(sentenceAt(sentences, c.span[0]).text.trim()),
  );
  if (candidates.length === 0) return [];
  const batch = candidates.slice(0, TRANSITION_CANDIDATE_CAP);

  const verdicts = await classifier.classify(batch.map((c) => c.clause));

  const seen = new Set(
    existingFacts.map(
      (f) => `${f.entityIndex}\u0000${f.predicate}\u0000${normalizeForGrounding(f.object)}`,
    ),
  );
  const harvested: ExtractedFact[] = [];
  for (const [i, candidate] of batch.entries()) {
    if (harvested.length >= TRANSITION_HARVEST_CAP) break;
    const verdict = verdicts[i];
    if (!verdict) continue;
    if (!ACCEPTED_CLASSES.has(verdict.cls)) continue;
    if (verdict.score < scoreFloor || verdict.margin < margin) continue;
    const object = clauseObject(trimmed, candidate.span);
    if (!object) continue;
    const sentence = sentenceAt(sentences, candidate.span[0]);
    const entityIndex = bindStateHolder(entities, sentence.text, speakerEntityIndex);
    if (entityIndex === null) continue;
    const key = `${entityIndex}\u0000${STATE_CHANGE_PREDICATE}\u0000${normalizeForGrounding(object)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    harvested.push({
      entityIndex,
      predicate: STATE_CHANGE_PREDICATE,
      object,
      confidence: TRANSITION_HARVEST_CONFIDENCE,
      clause: sentence.text.trim(),
      valueSpan: object,
    });
  }
  return harvested;
}
