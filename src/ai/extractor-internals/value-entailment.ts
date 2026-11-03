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
import * as chrono from 'chrono-node';
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
  const rest = withoutStatedDates(premise, value);
  if (numberClash(premise, rest)) return 'reject';
  return isValueWordGrounded(premise, rest) ? 'not_contradicted' : 'entailed';
}

/** An ISO calendar day or month inside a longer value ("…, introduced 2026-04-10"). */
const EMBEDDED_DATE = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g;

/** Every locale parser chrono ships — the library's list, not one of ours. */
const DATE_PARSERS = (Object.values(chrono) as unknown[]).filter(
  (p): p is { parse: (text: string) => chrono.ParsedResult[] } =>
    typeof (p as { parse?: unknown } | null)?.parse === 'function',
);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The calendar days and months the text names outright — year and month
 * stated, and the day when there is one — as ISO strings. A relative
 * expression ("next Tuesday") names none: what it resolves to depends on
 * when it was said, which the value check does not know.
 */
export function statedDates(text: string): Set<string> {
  const out = new Set<string>();
  for (const parser of DATE_PARSERS) {
    for (const { start } of parser.parse(text)) {
      if (!start.isCertain('year') || !start.isCertain('month')) continue;
      const month = `${start.get('year')}-${pad(start.get('month') ?? 0)}`;
      out.add(start.isCertain('day') ? `${month}-${pad(start.get('day') ?? 0)}` : month);
    }
  }
  return out;
}

/**
 * The value with every embedded ISO date the text itself names taken out.
 * The extractor writes "April 10, 2026" as 2026-04-10, and split into
 * digits that is a "04" nobody said: the number check dropped the fact as
 * a misreading and the word check sent it to an NLI model that does not
 * read dates (eval:halumem, 2026-11-03). Compared as a DATE it is the
 * text's own. A date the text does not name stays in, digits and all, so
 * a misread one ("2026-05-10" for April 10) is still a number clash.
 */
export function withoutStatedDates(premise: string, value: string): string {
  if (!EMBEDDED_DATE.test(value)) return value;
  const stated = statedDates(premise);
  return value.replace(EMBEDDED_DATE, (iso: string, y: string, m: string) =>
    stated.has(iso) || (iso.length === 7 && stated.has(`${y}-${m}`)) ? ' ' : iso,
  );
}

/** Whether a value stands given its check and the model's label (undefined: no model). */
export function valueStands(check: ValueCheck, label: NliLabel | undefined): boolean {
  if (check === 'reject') return false;
  if (label === undefined) return true;
  return check === 'entailed' ? label === 'entailment' : label !== 'contradiction';
}
