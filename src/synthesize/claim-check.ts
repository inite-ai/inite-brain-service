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
 * Pure: no model, no IO. The caller resolves handles to fact text and runs
 * the pairs through the NLI model; this module only splits, pairs and
 * decides. Not wired into synthesis — the battery (test/eval/claim-check)
 * measures it first.
 */
import type { NliLabel } from '../admin/nli-entailment';
import { parseFactHandle } from './fact-index';

/** One sentence of an answer, with the handles it cites. */
export interface AnswerSentence {
  /** The sentence as written, citation markers included. */
  text: string;
  /** The sentence with citation markers removed — the NLI hypothesis. */
  claim: string;
  /** Fact/relation handles the sentence cites, in order, deduplicated. */
  handles: string[];
}

/** A bracket group of citations: `[f1]`, `[f1, f2]`, `[f1][r2]`. */
const CITATION_GROUP = /\[([^[\]]{1,80})\]/gu;

const SENTENCES = new Intl.Segmenter(undefined, { granularity: 'sentence' });

/** The handles a bracket group names, or [] when it is not a citation group. */
function handlesIn(group: string): string[] {
  const parts = group.split(/[,;\s]+/u).filter(Boolean);
  const handles = parts.map((p) => parseFactHandle(p));
  return handles.every((h): h is string => h !== null) ? handles : [];
}

/**
 * The answer split into sentences (UAX #29 via Intl.Segmenter, every
 * script the platform knows), each with the handles it cites. A citation
 * group the segmenter leaves at the start of the next sentence ("… Lisbon.
 * [f1] She …") belongs to the sentence before it, as a reader takes it.
 */
export function splitAnswer(answer: string): AnswerSentence[] {
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
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
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
export function claimPairs(
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
export function claimStands(label: NliLabel | undefined): boolean {
  return label !== 'contradiction';
}
