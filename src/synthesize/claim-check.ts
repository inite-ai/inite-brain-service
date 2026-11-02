/**
 * Claim-level verification of a synthesized answer (spec #877) — the
 * MiniCheck / AIS attribution test, per sentence instead of per answer.
 *
 * The LLM verifier judges an answer as a whole, so one unsupported clause
 * inside an otherwise grounded answer passes, and in harness or keyless
 * mode no verifier runs at all. Each sentence that cites facts is checked
 * against exactly the facts it cites with the local NLI model
 * (src/admin/nli-entailment.ts — its own top label, no threshold of ours):
 * premise = the cited facts, hypothesis = the sentence without its
 * citation markers.
 *
 * Decision rule, fixed before measuring: a sentence is unsupported — and
 * would be removed — only when the model labels it a CONTRADICTION of what
 * it cites. `neutral` is kept: paraphrase, inference across facts and
 * phrasing the facts do not spell out read as neutral, and removing them
 * would strip correct answers. A sentence that cites nothing is not
 * checked here (the answer's own integrity gates own uncited text).
 *
 * The NLI model reads a swapped number or date as neutral, so a sentence
 * whose numbers clash with the cited facts' is unsupported too — the
 * deterministic check value grounding applies to extracted values (#851).
 * Measured both ways on test/eval/claim-check before wiring: NLI alone
 * caught 10/17 contradictions, NLI + numbers 12/17, neither removed a
 * supported or neutral sentence.
 *
 * No model and no IO here: the caller passes the NLI port
 * (IntentClassifierService.nli in serving, the ONNX pipeline in the
 * battery), so both run this same code.
 */
import type { NliLabel } from '../admin/nli-entailment';
import { numberClash } from '../ai/extractor-internals/value-entailment';
import { parseFactHandle, type Citation } from './fact-index';

/** One sentence of an answer, with the handles it cites. */
export interface AnswerSentence {
  /** The sentence as written, citation markers included. */
  text: string;
  /** The text with the whitespace that follows it — rebuilding an answer from spans keeps its layout. */
  span: string;
  /** The sentence with citation markers removed — the NLI hypothesis. */
  claim: string;
  /** Fact/relation handles the sentence cites, in order, deduplicated. */
  handles: string[];
}

/** A bracket group of citations: `[f1]`, `[f1, f2]`, `[f1][r2]`. */
const CITATION_GROUP = /\[([^[\]]{1,80})\]/gu;

const SENTENCES = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/**
 * A record id as served answers carry it once handles are expanded
 * (synthesize.helpers.ts, expandCitationHandles): `[knowledge_fact:<id>]`.
 */
const RECORD_ID = /^knowledge_(?:fact|edge):[A-Za-z0-9_]+$/u;

/** A citation token: the short handle the generator writes, or the record id it expands to. */
function citationToken(part: string): string | null {
  return parseFactHandle(part) ?? (RECORD_ID.test(part) ? part : null);
}

/** The handles a bracket group names, or [] when it is not a citation group. */
function handlesIn(group: string): string[] {
  const parts = group.split(/[,;\s]+/u).filter(Boolean);
  const handles = parts.map((p) => citationToken(p));
  return handles.every((h): h is string => h !== null) ? handles : [];
}

/**
 * The answer split into sentences (UAX #29 via Intl.Segmenter, every
 * script the platform knows), each with the handles it cites. A citation
 * group the segmenter leaves at the start of the next sentence ("… Lisbon.
 * [f1] She …") belongs to the sentence before it, as a reader takes it.
 */
function splitAnswer(answer: string): AnswerSentence[] {
  // ICU breaks a sentence only before what can start one, so "Porto. [f1]
  // She…" stays one segment. A citation group after the final mark is the
  // previous sentence's; moved before the mark, the segmenter sees the break.
  const normalized = answer.replace(
    /([.!?…])\s*((?:\[[^[\]]{1,80}\]\s*)+)/gu,
    (m, mark: string, group: string) =>
      handlesOf(group).length > 0 ? `${group.trimEnd()}${mark} ` : m,
  );
  const raw = [...SENTENCES.segment(normalized)].map((s) => s.segment);
  const merged: string[] = [];
  for (const segment of raw) {
    const leading = /^\s*((?:\[[^[\]]{1,80}\]\s*)+)/u.exec(segment);
    if (leading && merged.length > 0 && handlesOf(leading[1]!).length > 0) {
      merged[merged.length - 1] += leading[1]!;
      const rest = segment.slice(leading[0].length);
      if (rest.trim()) merged.push(rest);
    } else {
      merged.push(segment);
    }
  }
  return merged
    .filter((span) => span.trim())
    .map((span) => ({ span, text: span.trim() }))
    .map(({ span, text }) => ({
      text,
      span,
      claim: text
        .replace(CITATION_GROUP, (m, g: string) => (handlesIn(g).length > 0 ? '' : m))
        .replace(/\s+([.,;:!?])/gu, '$1')
        .replace(/\s{2,}/gu, ' ')
        .trim(),
      handles: handlesOf(text),
    }));
}

function handlesOf(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_GROUP)) {
    for (const h of handlesIn(m[1]!)) seen.add(h);
  }
  return [...seen];
}

/** One NLI pair for a sentence: what it cites, and what it claims. */
export interface ClaimPair {
  sentence: AnswerSentence;
  premise: string;
  hypothesis: string;
}

/**
 * The NLI pair of every sentence that cites at least one fact the caller
 * can resolve. Unresolvable handles (a hallucinated `[f99]`) are dropped
 * from the premise; a sentence left with none is not paired — the
 * citation gates already strip an id that is not in the evidence.
 */
function claimPairs(
  sentences: AnswerSentence[],
  factText: (handle: string) => string | undefined,
): ClaimPair[] {
  const pairs: ClaimPair[] = [];
  for (const sentence of sentences) {
    const premises = sentence.handles
      .map((h) => factText(h))
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (premises.length === 0 || !sentence.claim) continue;
    pairs.push({ sentence, premise: premises.join('\n'), hypothesis: sentence.claim });
  }
  return pairs;
}

/** The decision rule stated in the module note: only a contradiction is unsupported. */
function claimStands(label: NliLabel | undefined): boolean {
  return label !== 'contradiction';
}

/** The stored fact a citation names, as the check reads it. */
export type CitedFact = Pick<Citation, 'canonicalName' | 'predicate' | 'object'>;

/**
 * A cited fact as one NLI premise: the line the generator was shown
 * (fact-index.ts, `name — predicate: object`) with the predicate's
 * underscores read as the words they join.
 */
function claimPremise(fact: CitedFact): string {
  return `${fact.canonicalName} — ${fact.predicate.replace(/_/gu, ' ')}: ${fact.object}`;
}

/** The three-way NLI labels of hypotheses under one premise; undefined when no model can answer. */
export type NliPort = (
  premise: string,
  hypotheses: string[],
) => Promise<Array<NliLabel | undefined>>;

export interface ClaimCheckResult {
  /** Every sentence of the input answer, with the handles it cites. */
  sentences: AnswerSentence[];
  /** The answer without its unsupported sentences; the input itself when none was. */
  answer: string;
  /** The sentences removed, in answer order. */
  removed: AnswerSentence[];
  /** Citation tokens only removed sentences carried — their citations go with them. */
  droppedTokens: string[];
}

/**
 * Check every cited sentence of `answer` against what it cites and drop
 * the ones the facts contradict (module note). Sentences citing the same
 * facts share one NLI call. With no model available every label is
 * undefined, and only the number check can remove — fail-open, as value
 * grounding is.
 */
export async function checkClaims(
  answer: string,
  factOf: (token: string) => CitedFact | undefined,
  nli: NliPort,
): Promise<ClaimCheckResult> {
  const sentences = splitAnswer(answer);
  const pairs = claimPairs(sentences, (t) => {
    const fact = factOf(t);
    return fact ? claimPremise(fact) : undefined;
  });
  const byPremise = new Map<string, ClaimPair[]>();
  for (const pair of pairs)
    byPremise.set(pair.premise, [...(byPremise.get(pair.premise) ?? []), pair]);
  const unsupported = new Set<AnswerSentence>();
  for (const [premise, group] of byPremise) {
    const labels = await nli(
      premise,
      group.map((p) => p.hypothesis),
    );
    for (const [i, pair] of group.entries()) {
      if (!claimStands(labels[i]) || numberClash(premise, pair.hypothesis)) {
        unsupported.add(pair.sentence);
      }
    }
  }
  if (unsupported.size === 0) return { sentences, answer, removed: [], droppedTokens: [] };
  const kept = sentences.filter((s) => !unsupported.has(s));
  const keptTokens = new Set(kept.flatMap((s) => s.handles));
  const removed = sentences.filter((s) => unsupported.has(s));
  return {
    sentences,
    answer: kept
      .map((s) => s.span)
      .join('')
      .trim(),
    removed,
    droppedTokens: [...new Set(removed.flatMap((s) => s.handles))].filter(
      (t) => !keptTokens.has(t),
    ),
  };
}
