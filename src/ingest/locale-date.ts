/**
 * Absolute calendar dates written in a locale chrono cannot read.
 *
 * WHY THIS EXISTS. `event-time.ts` dispatches to a `chrono-node` locale
 * parser, and chrono ships parsers for thirteen languages. For everything
 * else the code falls back to `chrono.en`, which on non-Latin text parses
 * nothing at all — so the caller keeps the message time and the fact is
 * stamped with the day it was SAID rather than the day it names. Measured
 * on the Tier-0 multilingual matrix (2026-09-14), that is exactly what
 * happened:
 *
 *     ml.temp.ar   "٣ مارس ٢٠٢٦"   -> 2026-09-14   (the run's own date)
 *     ml.temp.hi   "3 मार्च 2026"   -> 2026-09-14   (the run's own date)
 *
 * against a gold of 2026-03-03. Not "off by a bit" — six months wrong,
 * and wrong in the way that reads as an answer rather than as a gap.
 *
 * WHERE THE MONTH NAMES COME FROM: ICU, via `Intl.DateTimeFormat`. Not a
 * hand-written table — a hand-written table is a list of facts about
 * human languages maintained by someone who does not speak them, and it
 * is wrong the first time a locale inflects. ICU already ships CLDR and
 * Node already links it, so the names are read out of the platform:
 *
 *   - FORMAT context (`{day, month, year}` → `formatToParts`) gives the
 *     inflected form a date actually contains — ru "марта" (genitive),
 *     pl "marca", cs "března", uk "березня" — not the nominative
 *     "март" / "marzec" a standalone lookup returns. Both are collected,
 *     because a locale may use either.
 *   - `-u-ca-gregory-nu-latn` pins the calendar and numerals. Without it
 *     `th` answers in the Buddhist era (2569) and `fa` in the Persian
 *     calendar (۱۲ اسفند ۱۴۰۴), and the month name would not be the one
 *     appearing in a Gregorian date.
 *
 * This covers every locale ICU knows, which is far more than the gap that
 * prompted it: th, he, fa, tr, id, pl, cs, uk and the rest have no chrono
 * parser either and were failing the same silent way.
 *
 * DELIBERATELY CONSERVATIVE, because it runs as a fallback after chrono
 * and a false positive here would invent an event date:
 *
 *   1. A match needs a month NAME, a day and a four-digit YEAR. "we may
 *      go" cannot parse as May, and a bare "مارس ٢٠٢٦" is declined rather
 *      than guessed at a day.
 *   2. Month names that contain a digit are dropped from the lexicon
 *      entirely — ja "3月", ko "3월", vi "tháng 3", zh "三月"'s numeric
 *      siblings. Those are not names a lexicon can separate from the
 *      number beside them; they need a positional grammar. chrono covers
 *      ja/zh natively, so the loss is vi and ko-absolute, stated rather
 *      than papered over.
 *   3. A word two months share (some short forms collide) is dropped.
 *   4. The assembled day must exist in that month — 31 February is
 *      refused, not silently rolled into March.
 */
import { normalizeDigits } from '../common/locale-digits';

/** A resolved absolute date plus the span of text that produced it. */
export interface LocaleDateMatch {
  /** UTC midnight of the named calendar day. */
  date: Date;
  /** The matched substring, for tracing. */
  expr: string;
}

/** Month words for one locale, longest first so "september" beats "sep". */
interface MonthLexicon {
  byWord: ReadonlyMap<string, number>;
  words: readonly string[];
}

/** Built once per locale. `null` memoises "this locale yields nothing". */
const LEXICONS = new Map<string, MonthLexicon | null>();

/** A day in mid-month, so no timezone rounding can shift the month part. */
const SAMPLE_DAY = 15;

/**
 * Casefold for lookup. `toLowerCase` is a no-op in Arabic, Devanagari and
 * Thai (they are unicameral) and does the right thing in Latin/Cyrillic/
 * Greek. The trailing dot goes because ICU abbreviates with one ("Mär.",
 * "бер.", "มี.ค." — the interior dots are kept, only the tail is noise).
 */
function fold(word: string): string {
  return normalizeDigits(word).toLowerCase().trim().replace(/\.+$/u, '');
}

/**
 * The month as a date actually writes it, plus — where the locale glues a
 * proclitic onto it — the glued form. Hebrew formats 3 March as
 * "3 במרץ 2026": ICU reports the month as "מרץ" and the ב as part of the
 * preceding literal, so a bare-word search finds "מרץ" with a letter on
 * its left and (correctly) refuses it as a mid-word hit.
 *
 * The prefix is taken from ICU's own literal rather than from any
 * knowledge of Hebrew: whatever letters the locale leaves hanging on the
 * month's left edge become a second spelling of that month. Locales that
 * separate with a space or punctuation (" de ", ". ") contribute nothing.
 */
function monthFormsOf(fmt: Intl.DateTimeFormat, date: Date): string[] {
  const parts = fmt.formatToParts(date);
  const at = parts.findIndex((p) => p.type === 'month');
  if (at === -1) return [];
  const month = parts[at]!.value;
  const forms = [month];
  const before = at > 0 ? parts[at - 1] : undefined;
  if (before?.type === 'literal') {
    const glued = /(\p{L}+)$/u.exec(before.value)?.[1];
    if (glued) forms.push(glued + month);
  }
  return forms;
}

/**
 * Read the twelve month names for a locale out of ICU, in every width and
 * context we can match against. Returns null when nothing usable survives
 * the filters (a locale whose month names are numeric, or an unknown tag).
 */
function buildLexicon(locale: string): MonthLexicon | null {
  // Pin the calendar and numbering system: we are parsing Gregorian dates
  // written in ASCII-normalized digits, and a locale's DEFAULT calendar
  // may be neither.
  const tag = `${locale}-u-ca-gregory-nu-latn`;
  let inContext: Intl.DateTimeFormat;
  let standalone: Intl.DateTimeFormat;
  let short: Intl.DateTimeFormat;
  try {
    const base = { timeZone: 'UTC' } as const;
    inContext = new Intl.DateTimeFormat(tag, {
      ...base,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    standalone = new Intl.DateTimeFormat(tag, { ...base, month: 'long' });
    short = new Intl.DateTimeFormat(tag, { ...base, month: 'short' });
  } catch {
    return null; // RangeError on a malformed tag.
  }

  // A word two months share carries no information; collect then discard.
  const claimed = new Map<string, number | 'ambiguous'>();
  for (let m = 0; m < 12; m++) {
    const sample = new Date(Date.UTC(2026, m, SAMPLE_DAY));
    for (const raw of [
      ...monthFormsOf(inContext, sample),
      standalone.format(sample),
      short.format(sample),
    ]) {
      const word = fold(raw);
      // Rule 1: a name made of digits is the number beside it. Rule 2: a
      // one- or two-character word is too small to match safely inside
      // running text.
      if (word.length < 3 || /\d/u.test(word)) continue;
      const seen = claimed.get(word);
      if (seen === undefined) claimed.set(word, m);
      else if (seen !== m) claimed.set(word, 'ambiguous');
    }
  }

  const byWord = new Map<string, number>();
  for (const [word, m] of claimed) if (m !== 'ambiguous') byWord.set(word, m);
  if (byWord.size === 0) return null;
  // Longest first: "september" must win over "sep" at the same position.
  const words = [...byWord.keys()].sort((a, b) => b.length - a.length);
  return { byWord, words };
}

function lexiconFor(locale: string): MonthLexicon | null {
  const cached = LEXICONS.get(locale);
  if (cached !== undefined) return cached;
  const built = buildLexicon(locale);
  LEXICONS.set(locale, built);
  return built;
}

/** True when `text[index]` is a letter — used as a word boundary test. */
function isLetterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  return /\p{L}/u.test(text[index]!);
}

/** Every `\d{1,4}` run in `text`, with where it starts. */
function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const re = /\d{1,4}/gu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ value: Number(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Distance from a number token to the month word occupying [ms, me). */
function gapTo(tok: { start: number; end: number }, ms: number, me: number): number {
  if (tok.end <= ms) return ms - tok.end;
  if (tok.start >= me) return tok.start - me;
  return 0;
}

type NumberToken = { value: number; start: number; end: number };

/**
 * The day (1-2 digits, 1..31) and the year (4 digits, ≥ 1000) sitting
 * nearest the month word at [ms, me) — or null when either is absent.
 * Nearest, because "room 305 on 3 марта 2026" has two candidates for the
 * day's slot and the one beside the month is the one that belongs to it.
 */
function dayAndYearNearest(
  numbers: readonly NumberToken[],
  ms: number,
  me: number,
): { day: NumberToken; year: NumberToken } | null {
  let day: NumberToken | undefined;
  let year: NumberToken | undefined;
  for (const tok of numbers) {
    const width = tok.end - tok.start;
    const gap = gapTo(tok, ms, me);
    if (width === 4 && tok.value >= 1000) {
      if (!year || gap < gapTo(year, ms, me)) year = tok;
    } else if (width <= 2 && tok.value >= 1 && tok.value <= 31) {
      if (!day || gap < gapTo(day, ms, me)) day = tok;
    }
  }
  return day && year ? { day, year } : null;
}

/**
 * Resolve an explicit `day month-name year` date written in `locale`.
 * Returns null unless all three parts are present and name a real day.
 *
 * Order within the expression is not assumed: the day is whichever 1-2
 * digit number sits nearest the month word and the year whichever 4-digit
 * one does, which reads "March 3, 2026", "3 марта 2026" and "3 de marzo
 * de 2026" without a per-locale pattern.
 */
export function parseLocaleAbsoluteDate(
  clause: string,
  locale: string | undefined,
): LocaleDateMatch | null {
  if (!clause || !locale) return null;
  const lex = lexiconFor(locale);
  if (!lex) return null;

  // One haystack for both the word search and the number scan, so every
  // index below refers to the same string. normalizeDigits is
  // position-preserving, so native ٣ / ३ digits become ASCII in place.
  const hay = normalizeDigits(clause).toLowerCase();
  const numbers = numberTokens(hay);
  if (numbers.length < 2) return null;

  for (const word of lex.words) {
    let from = 0;
    for (let at = hay.indexOf(word, from); at !== -1; at = hay.indexOf(word, from)) {
      from = at + 1;
      const end = at + word.length;
      // Whole-word only: "марта" must not match inside a longer word.
      // Digits and punctuation are legal neighbours, which is what lets
      // an unspaced "3มีนาคม2026" still read.
      if (isLetterAt(hay, at - 1) || isLetterAt(hay, end)) continue;

      const parts = dayAndYearNearest(numbers, at, end);
      if (!parts) continue;
      const { day, year } = parts;

      const month = lex.byWord.get(word)!;
      const date = new Date(Date.UTC(year.value, month, day.value));
      // 31 February is not a date. Constructing it rolls into March, so
      // the only honest check is whether the day survived the round trip.
      if (date.getUTCDate() !== day.value || date.getUTCMonth() !== month) continue;

      const spanStart = Math.min(at, day.start, year.start);
      const spanEnd = Math.max(end, day.end, year.end);
      return { date, expr: hay.slice(spanStart, spanEnd).trim() };
    }
  }
  return null;
}
