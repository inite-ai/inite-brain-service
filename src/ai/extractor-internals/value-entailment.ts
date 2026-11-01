/**
 * Value grounding for the OPEN (dialogue) vocabulary.
 *
 * The closed vocabulary drops a fact whose value is not a verbatim span of
 * the input. The open one cannot: its contract asks for a clean, faithful
 * value that need not be a substring ("single" for "not seeing anyone",
 * "late bedtime" for "didn't get to bed until 2am"), so the substring gate
 * was bypassed outright. That let any value through: a value the model
 * hallucinated, or one an injected instruction made it write, was stored
 * as memory with nothing marking it.
 *
 * The check is the attribution test of AIS / AlignScore, with the local
 * NLI model (nli-entailment.ts, its own top label, no threshold of ours):
 *  - a number the value states that differs from every number the text
 *    states is a misreading, rejected outright (the NLI model reads "8080"
 *    as entailed by "port 8443");
 *  - a value whose content words are all in what the extractor read, or a
 *    resolved date, stands unless the text CONTRADICTS the fact: the words
 *    are there, but "team lead: Diego" may be what the turn says ended;
 *  - any other value stands only if the text ENTAILS the fact.
 * Measured on 46 faithful values (copies and paraphrases, three languages)
 * and 24 hallucinated or injected ones: 43 kept, 23 rejected. The three
 * lost are paraphrases the base NLI model does not resolve ("single" for
 * "not seeing anyone"); the turn itself stays in the raw episode layer.
 * With no NLI model available the value is kept, as before this check.
 */
import type { NliLabel } from '../../admin/nli-entailment';
import type { ConversationContext } from './prompts';

/** One fact as the check reads it. */
export interface ValueClaim {
  entityName: string;
  predicate: string;
  value: string;
}

/**
 * The fact as a sentence for NLI: "Ana works as: assistant manager". The
 * colon form measured better than "The works as of Ana is …".
 */
export function valueHypothesis(claim: ValueClaim): string {
  return `${claim.entityName} ${claim.predicate.replace(/_/g, ' ')}: ${claim.value}`;
}

/**
 * What the extractor read: the turn first, then the earlier turns it was
 * shown and the names it was told (speaker, addressee). The turn leads so
 * the model's truncation, which cuts from the end, keeps it.
 */
export function valuePremise(turn: string, context?: ConversationContext): string {
  const earlier = (context?.memory?.recentTurns ?? [])
    .slice()
    .reverse()
    .map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text));
  return [turn, ...earlier].join('\n');
}

/** A resolved calendar date or instant: a computed value no sentence entails verbatim. */
const RESOLVED_DATE = /^\d{4}-\d{2}(-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?)?$/;

// Letters of word-spaced scripts, where a value word may be an inflected
// form of the input's ("Лиссабон" for "Лиссабона").
const SPACED = /^[A-Za-zÀ-ɏЀ-ӿ]/;

/**
 * Every content word of `value` is in `premise`: a number exactly, a word
 * of a spaced script by a shared stem covering 60% of the longer word
 * (inflection passes, "Лиссабон"/"Лиссабона"; a compound does not,
 * "steak"/"steakhouse"), anything else as a substring. Words under three
 * characters carry no content and are skipped; a value with no content
 * word left is not grounded by words.
 */
export function isValueWordGrounded(premise: string, value: string): boolean {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase();
  const p = norm(premise);
  const premiseWords = p.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = norm(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 || /\p{N}/u.test(w));
  if (words.length === 0) return false;
  return words.every((w) => {
    if (/\p{N}/u.test(w)) return premiseWords.includes(w);
    if (!SPACED.test(w)) return p.includes(w);
    return premiseWords.some((pw) => {
      const need = Math.max(
        Math.min(4, w.length, pw.length),
        Math.ceil(0.6 * Math.max(w.length, pw.length)),
      );
      let i = 0;
      while (i < w.length && i < pw.length && w[i] === pw[i]) i++;
      return i >= need;
    });
  });
}

const NUMBER = /\d[\d,.]*\d|\d/g;

/**
 * The value states a number the text does not, while the text states
 * numbers of its own: a misread figure. A text that spells its numbers
 * out ("fifty thousand") has none to compare and is left to NLI.
 */
export function numberClash(premise: string, value: string): boolean {
  const digits = (s: string) => (s.match(NUMBER) ?? []).map((n) => n.replace(/[,.]/g, ''));
  const said = digits(premise);
  const claimed = digits(value);
  return (
    claimed.length > 0 &&
    said.length > 0 &&
    claimed.some((n) => !said.some((m) => m.includes(n) || n.includes(m)))
  );
}

/** What a value needs from the NLI model to stand. */
export type ValueCheck = 'reject' | 'not_contradicted' | 'entailed';

export function valueCheck(premise: string, value: string): ValueCheck {
  // A resolved date is computed from the text ("next Tuesday"), so its
  // digits need not be the text's.
  if (RESOLVED_DATE.test(value.trim())) return 'not_contradicted';
  if (numberClash(premise, value)) return 'reject';
  return isValueWordGrounded(premise, value) ? 'not_contradicted' : 'entailed';
}

/** Whether a value stands given its check and the model's label (undefined: no model). */
export function valueStands(check: ValueCheck, label: NliLabel | undefined): boolean {
  if (check === 'reject') return false;
  if (label === undefined) return true;
  return check === 'entailed' ? label === 'entailment' : label !== 'contradiction';
}
