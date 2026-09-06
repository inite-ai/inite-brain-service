import nlp from 'compromise';

/**
 * Transition morphology stage (EXTRACTOR_TRANSITION_CLASSIFIER, stage 1
 * of 2 — the semantic stage lives in transition-classifier.ts).
 *
 * The state-transition eval battery proved transition verbs are lost or
 * unstable in extraction. This module is the LANGUAGE-STRUCTURE half of
 * the fix: it finds candidate verb clauses using `compromise` (pure-JS
 * English morphology, zero deps) WITHOUT any verb lexicon — that is the
 * point. Morphology proposes ("a past-tense, non-negated verb with a
 * complement happened here"), the embedding-prototype classifier
 * disposes ("…and it means a completed disposal"). A parallel
 * deterministic English lexicon lane (state-verb-harvest) composes with
 * this in a follow-up wiring PR.
 *
 * Pure module: no Nest/DI imports, no env reads, no LLM calls.
 *
 * ── What compromise CAN and CANNOT detect (probed on 14.16.0) ────────
 *
 * CAN, reliably:
 *  - simple past on inflected forms, including subjectless/elliptical
 *    clauses ("Dropped out of the yoga course." → simple-past) and
 *    phrasal lemmas ("Dropped out" → infinitive "drop out");
 *  - grammatical negation across shapes: "haven't sold", "didn't
 *    sell", "never sold" all carry #Negative;
 *  - modality: "will quit" → FutureTense grammar, "might sell" →
 *    modal-infinitive; copulas are flagged (grammar.copula) so "was"
 *    in "was thinking of quitting" is not mistaken for an event verb;
 *  - governed infinitives: in "want to quit the team" the embedded
 *    "quit" is grammar.isInfinitive, not a finite event.
 *
 * CANNOT (documented limitations, each handled honestly below):
 *  - zero-derivation past ("I quit the club", "hurt my back"): the
 *    surface form equals the infinitive, and compromise resolves the
 *    ambiguity to simple-present. We re-resolve to Past ONLY when the
 *    past form is spelled identically AND the clause carries an
 *    explicit past-time cue ("today", "yesterday", "last …", "… ago").
 *    A bare cue-less "I quit the club" stays Present here — English
 *    morphology alone genuinely cannot decide it, and the semantic
 *    stage still gets a shot at it via prototypes;
 *  - argument structure: compromise has no dependency parse, so
 *    "complement" means "noun-ish material after the verb inside the
 *    clause", which includes adjuncts ("quit … yesterday" counts).
 *    Distinguishing direct objects from adjuncts is out of scope;
 *  - spurious verb readings: noun/verb-ambiguous tokens are sometimes
 *    tagged as verbs ("the vendor contract" → verb "contract"). These
 *    surface as Present-tense analyses and never pass the completed
 *    filter, but callers iterating raw analyses should expect them.
 */

/** One analyzed verb group inside one clause. */
export interface TransitionCandidate {
  /** The clause text as compromise segmented it. */
  clause: string;
  /** Infinitive lemma of the verb group (phrasal kept: "drop out"). */
  verbLemma: string;
  /**
   * 'Past' | 'Present' | 'Future' from compromise grammar, with the
   * documented zero-derivation + past-cue re-resolution to 'Past'.
   * Other compromise tenses pass through as-is (string-typed escape
   * hatch — grammar.tense is open-ended).
   */
  tense: 'Past' | 'Present' | 'Future' | string;
  /** Grammatical negation on the verb group (#Negative). */
  negated: boolean;
  /**
   * True when the analysis is hypothetical rather than asserted:
   * a non-'will' modal governs the verb group (might/may/could/would),
   * the verb is a governed infinitive/gerund under a planning verb
   * ("thinking about selling", "want to quit"), or the clause itself
   * is governed by such a verb.
   */
  hypothetical: boolean;
  /**
   * True when noun-ish material (noun / pronoun / value / date) follows
   * the verb group inside the clause. Adjuncts count — see limitations.
   */
  hasComplement: boolean;
  /** [start, end) offsets of the clause in the ORIGINAL input text. */
  span: [number, number];
}

/**
 * Planning/intention governors: a clause where one of these verbs takes
 * an infinitive or gerund complement asserts an INTENTION, not an
 * event — every verb analysis from such a clause is hypothetical.
 * Deliberately small and closed: this is a modality guard, not the
 * banned verb lexicon (transition verbs themselves stay unlisted).
 */
const HYPOTHETICAL_GOVERNOR =
  /\b(?:think(?:s|ing)?|thought|plan(?:s|ning|ned)?|consider(?:s|ing|ed)?|hop(?:e|es|ing|ed)|want(?:s|ing|ed)?|intend(?:s|ing|ed)?|wish(?:es|ing|ed)?|dream(?:s|ing|t|ed)?)\s+(?:about|of|to)\b/i;

/**
 * Non-'will' modals make the verb group hypothetical. 'will' is a
 * committed future (tense comes back 'Future' and the completed filter
 * excludes it on tense, not on modality).
 */
const HYPOTHETICAL_MODAL = /\b(?:might|may|could|would|should)\b/i;

/**
 * Past-time cues that resolve a zero-derivation form ("quit", "hurt",
 * "put", "cut", "set", …) to Past. Bounded, documented list — a cue
 * must assert that the clause narrates elapsed time.
 */
const PAST_TIME_CUE =
  /\b(?:yesterday|today|tonight|ago|last\s+\w+|back\s+(?:in|on)|this\s+(?:morning|afternoon|evening|week|weekend|month|year|spring|summer|autumn|fall|winter))\b/i;

/** Term tags that count as complement material after the verb. */
const COMPLEMENT_TAGS = new Set(['Noun', 'Pronoun', 'Value', 'Date', 'Adjective']);

/** Minimal shapes for the compromise json() output we consume. */
interface CjOffset {
  start: number;
  length: number;
}
interface CjTerm {
  tags?: string[];
  offset?: CjOffset;
}
interface CjVerbGrammar {
  tense?: string;
  copula?: boolean;
  isInfinitive?: boolean;
  form?: string;
}
interface CjJsonRow {
  text?: string;
  offset?: CjOffset;
  terms?: CjTerm[];
  verb?: { grammar?: CjVerbGrammar };
}

/** compromise view surface used here (the shipped types lag the API). */
interface CView {
  forEach(fn: (m: CView) => void): void;
  json(opts?: Record<string, unknown>): CjJsonRow[];
  text(): string;
  has(match: string): boolean;
  clauses(): CView;
  verbs(): CView;
  conjugate(): Array<Record<string, string>>;
}

/** Map compromise grammar.tense to the public tense vocabulary. */
function mapTense(tense: string | undefined): TransitionCandidate['tense'] {
  switch (tense) {
    case 'PastTense':
      return 'Past';
    case 'PresentTense':
      return 'Present';
    case 'FutureTense':
      return 'Future';
    default:
      return tense ?? 'Unknown';
  }
}

/**
 * Zero-derivation re-resolution: compromise called this verb Present
 * (simple-present or imperative — the subjectless "Quit the chess club
 * yesterday" parses as imperative), its past form is spelled exactly
 * like the surface form, and the clause carries an explicit past-time
 * cue. Only then is Present overridden to Past.
 */
function resolvesToZeroDerivationPast(args: {
  tense: TransitionCandidate['tense'];
  form: string | undefined;
  surface: string;
  pastForm: string | undefined;
  clauseText: string;
}): boolean {
  if (args.tense !== 'Present') return false;
  if (args.form !== 'simple-present' && args.form !== 'imperative') return false;
  if (!args.pastForm) return false;
  // Last word of the verb group (adverbs/aux attach: "actually cancelled").
  const headWord = args.surface.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  if (headWord !== args.pastForm.toLowerCase()) return false;
  return PAST_TIME_CUE.test(args.clauseText);
}

/**
 * Analyze `text` into per-verb-group transition candidates. Returns ONE
 * entry per non-copula verb group in every clause — including negated,
 * hypothetical, future and complement-less analyses, each labeled — so
 * the caller (or `isCompletedTransition`) applies the candidate policy
 * explicitly instead of this function silently swallowing evidence.
 */
export function findTransitionCandidates(text: string): TransitionCandidate[] {
  const out: TransitionCandidate[] = [];
  if (!text.trim()) return out;
  const doc = nlp(text) as unknown as CView;
  doc.clauses().forEach((clauseView) => {
    const clauseRow = clauseView.json({ offset: true, terms: { tags: true, offset: true } })[0];
    if (!clauseRow?.offset) return;
    const clauseText = clauseView.text();
    const clauseStart = clauseRow.offset.start;
    const clauseEnd = clauseRow.offset.start + clauseRow.offset.length;
    const clauseTerms = clauseRow.terms ?? [];
    const clauseHypothetical = HYPOTHETICAL_GOVERNOR.test(clauseText);
    clauseView.verbs().forEach((verbView) => {
      const verbRow = verbView.json({ offset: true })[0];
      const grammar = verbRow?.verb?.grammar ?? {};
      if (grammar.copula) return; // "was" in "was thinking of quitting"
      const surface = verbView.text();
      const conj = verbView.conjugate()[0] ?? {};
      const lemma = (conj['Infinitive'] ?? surface.split(/\s+/).pop() ?? surface).toLowerCase();
      let tense = mapTense(grammar.tense);
      const zeroDerivationArgs = {
        tense,
        form: grammar.form,
        surface,
        pastForm: conj['PastTense'],
        clauseText,
      };
      if (resolvesToZeroDerivationPast(zeroDerivationArgs)) tense = 'Past';
      const gerund = verbView.has('#Gerund');
      const hypothetical =
        clauseHypothetical ||
        (verbView.has('#Modal') && HYPOTHETICAL_MODAL.test(surface)) ||
        grammar.isInfinitive === true ||
        // A gerund is only an asserted event when it heads a progressive
        // group ("are planning"); a bare gerund ("selling" in "about
        // selling my drone") is a non-finite mention.
        (gerund && grammar.form !== 'present-progressive');
      const verbEnd = verbRow?.offset ? verbRow.offset.start + verbRow.offset.length : clauseStart;
      const hasComplement = clauseTerms.some(
        (t) =>
          (t.offset?.start ?? -1) >= verbEnd &&
          (t.tags ?? []).some((tag) => COMPLEMENT_TAGS.has(tag)),
      );
      out.push({
        clause: clauseText,
        verbLemma: lemma,
        tense,
        negated: verbView.has('#Negative'),
        hypothetical,
        hasComplement,
        span: [clauseStart, clauseEnd],
      });
    });
  });
  return out;
}

/**
 * The candidate policy from the design note: a COMPLETED-transition
 * candidate is a past-tense, non-negated, non-hypothetical verb with a
 * non-empty object/complement in its clause. Everything else is either
 * an intention/negation signal (still valuable to the caller) or noise.
 */
export function isCompletedTransition(c: TransitionCandidate): boolean {
  return c.tense === 'Past' && !c.negated && !c.hypothetical && c.hasComplement;
}

/** Convenience: only the completed-transition candidates of `text`. */
export function findCompletedTransitions(text: string): TransitionCandidate[] {
  return findTransitionCandidates(text).filter(isCompletedTransition);
}
