/**
 * Event-time resolution — lift the *occurrence* date of an episodic fact out
 * of the relative temporal expression in its clause, instead of stamping the
 * message time.
 *
 * Why this exists: mention ingest sets a fact's `validFrom` to `dto.emittedAt`
 * (when the sentence was SAID). But conversational statements routinely refer
 * to when something HAPPENED, in the past, relative to now: "I went to the
 * support group *yesterday*", "I painted that *last year*", "*три недели
 * назад*". Stamping the message time makes every such fact land one day / one
 * year / one week late — the exact offset LoCoMo "when did X" questions punish
 * (gold "7 May" vs answer "8 May").
 *
 * Multilingual by design. The heavy lifting is `chrono-node` — a battle-tested
 * NL date parser that resolves relative expressions against a reference instant
 * across many languages (en, ru, fr, de, es, pt, nl, ja, uk, it, zh, …) and is
 * conservative about bare numbers ("2000 meters", "room 2015" do NOT parse as
 * dates). We dispatch the parser by the clause's detected language, bias to the
 * PAST (an "occurred" reference is behind us), clamp to a sane lookback window,
 * and fall back to a narrow explicit-year regex for "since 2016" / "в 2016"
 * that chrono leaves unparsed. Anything unresolvable returns null and the
 * caller keeps the message time — never a guess.
 *
 * Enabled by `INGEST_EVENT_TIME_EXTRACTION` (default off; re-ingest to apply).
 */
import * as chrono from 'chrono-node';
import { detectLanguage } from '../ai/locale/language-detector';
import { normalizeDigits } from '../common/locale-digits';

/** Sanity window: an event referenced in conversation is in the past, and we
 *  won't trust a resolved date more than this far back (guards a stray parse). */
const MAX_LOOKBACK_YEARS = 25;

/** The slice of a chrono locale module we use. Locale modules (`chrono.en`,
 *  `chrono.ru`, …) are namespaces, each a distinct type, so we type them
 *  structurally by the one method we call. */
interface ChronoLike {
  parse(
    text: string,
    ref?: Date,
    opt?: { forwardDate?: boolean },
  ): Array<{ text: string; start: { date(): Date } }>;
}

/** chrono locale parsers keyed by ISO-639-1 code. Languages chrono covers
 *  natively; anything else falls back to English (which still catches ISO
 *  dates and digit patterns). Russian/Ukrainian are first-class in chrono. */
const PARSERS: Record<string, ChronoLike> = {
  en: chrono.en,
  ru: chrono.ru,
  uk: chrono.uk,
  fr: chrono.fr,
  de: chrono.de,
  es: chrono.es,
  pt: chrono.pt,
  nl: chrono.nl,
  ja: chrono.ja,
  it: chrono.it,
  zh: chrono.zh,
  fi: chrono.fi,
  vi: chrono.vi,
};

/** Explicit past year in a temporal context that chrono leaves unparsed
 *  ("since 2016", "back in 2019", "в 2016", "с 2018"). Deliberately narrow: the
 *  year must follow a temporal preposition, so a bare quantity ("2000 meters",
 *  "room 2015") is never mistaken for a date. EN + RU prepositions. */
// NB: JS `\b` is ASCII-only, so it never sits before a Cyrillic letter — the
// RU prepositions в/с are anchored on start-or-whitespace instead.
const YEAR_FALLBACK =
  /(?:\b(?:in|since|back in|around|during|from|of)\s+|(?:^|\s)[вс]\s+)((?:19|20)\d{2})\b/i;

export interface EventTime {
  /** Resolved occurrence date (UTC midnight). */
  date: Date;
  /** The matched expression / source, for tracing. */
  expr: string;
}

export interface ResolveEventTimeOptions {
  /** ISO-639-1 language of the clause. When omitted it is auto-detected. */
  lang?: string;
  /**
   * Multilingual Tier 4 (MULTILINGUAL_TEMPORAL). When true, three otherwise-
   * conflated concerns turn on together: (1) ar/hi/ko relative-expression
   * recognition (chrono has no parser for them — they otherwise fall to the
   * English parser and silently miss), (2) locale-aware digit parsing (native
   * ٣ / ५ digits in those expressions), and (3) — when `timeZone` is also set
   * — the day-shift fix below. Absent / false ⇒ byte-identical legacy
   * behavior (the caller passes nothing, so the default path is unchanged).
   */
  localeTime?: boolean;
  /**
   * IANA timezone of the speaker's session (e.g. 'Asia/Tokyo'). Only consulted
   * when `localeTime` is true. Fixes the atUtcMidnight day-shift: a message
   * emitted near a UTC day boundary is anchored to the speaker's LOCAL calendar
   * day, so "yesterday" resolves against the day they actually saw, not the UTC
   * day. An unknown/invalid zone degrades to the UTC-day behavior (never
   * throws). The stored date stays language-neutral ISO-8601 (UTC-midnight of
   * the resolved calendar day).
   */
  timeZone?: string;
}

function atUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The speaker's LOCAL calendar Y/M/D for an instant, via Intl (ICU tz DB —
 *  no new dep). Independent of the HOST timezone. Null on an unknown zone. */
function localeYmd(date: Date, timeZone: string): { y: number; m: number; d: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const pick = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
    const y = pick('year');
    const m = pick('month');
    const d = pick('day');
    if (![y, m, d].every(Number.isFinite)) return null;
    return { y, m: m - 1, d };
  } catch {
    return null; // RangeError on an invalid IANA zone → UTC-day fallback.
  }
}

/** UTC-midnight of the speaker's LOCAL calendar day (the language-neutral
 *  storage slot). Falls back to the UTC-day midnight on an unknown zone. */
function atLocaleMidnight(date: Date, timeZone: string): Date {
  const p = localeYmd(date, timeZone);
  return p ? new Date(Date.UTC(p.y, p.m, p.d)) : atUtcMidnight(date);
}

/** UTC-NOON of the speaker's local calendar day — the chrono reference under a
 *  timezone. Noon is used so relative math ("yesterday", "3 weeks ago") is
 *  anchored on the correct local day AND is host-timezone-independent: 12:00Z
 *  falls on the same calendar day in every realistic host zone, so chrono's
 *  day component is stable regardless of where the process runs. Falls back to
 *  the raw instant on an unknown zone (byte-identical). */
function localeNoonUtc(date: Date, timeZone: string): Date {
  const p = localeYmd(date, timeZone);
  return p ? new Date(Date.UTC(p.y, p.m, p.d, 12)) : date;
}

type RelUnit = 'day' | 'week' | 'month' | 'year';

/**
 * Per-language relative-expression grammar for scripts chrono has NO parser
 * for (Arabic, Hindi/Devanagari, Korean). Digits are ASCII-normalized before
 * matching, so native ٣ / ५ work. Deliberately covers the high-frequency
 * conversational forms (today / yesterday / day-before, "N <unit> ago", "last
 * <unit>"); dual/spelled-out numbers and calendar-name dates are DEFERRED to
 * chrono coverage (a future chrono locale) — this closes the silent
 * English-fallback gap, it is not a full NL date grammar.
 *
 * NOTE on ambiguity: Hindi कल = yesterday OR tomorrow and परसों = day-before
 * OR day-after; event-time is past-biased ("occurred" is behind us), so both
 * resolve to the PAST reading, consistent with chrono's forwardDate:false.
 */
interface RelGrammar {
  fixed: ReadonlyArray<readonly [RegExp, number]>; // phrase → day offset (<0 = past)
  lastUnit: ReadonlyArray<readonly [RegExp, RelUnit]>; // "last <unit>" → subtract 1
  ago: ReadonlyArray<readonly [RegExp, RelUnit]>; // capture-group-1 = N, subtract N units
}

const REL_GRAMMARS: Partial<Record<string, RelGrammar>> = {
  ko: {
    fixed: [
      [/그저께|그제/u, -2],
      [/어제/u, -1],
      [/오늘/u, 0],
    ],
    lastUnit: [
      [/지난\s*주/u, 'week'],
      [/지난\s*달/u, 'month'],
      [/작년|지난\s*해/u, 'year'],
    ],
    ago: [
      [/(\d+)\s*일\s*전/u, 'day'],
      [/(\d+)\s*주\s*전/u, 'week'],
      [/(\d+)\s*(?:개월|달)\s*전/u, 'month'],
      [/(\d+)\s*년\s*전/u, 'year'],
    ],
  },
  hi: {
    // Devanagari doesn't delimit suffixes with spaces, so the bare day-words
    // are guarded by script boundaries (कल = yesterday must not match inside
    // कलम "pen" / कला "art"). Longer phrases below carry their own context.
    fixed: [
      [/(?<![ऀ-ॿ])परसों(?![ऀ-ॿ])/u, -2],
      [/(?<![ऀ-ॿ])कल(?![ऀ-ॿ])/u, -1],
      [/(?<![ऀ-ॿ])आज(?![ऀ-ॿ])/u, 0],
    ],
    lastUnit: [
      [/पिछले\s*(?:हफ्ते|सप्ताह)/u, 'week'],
      [/पिछले\s*महीने/u, 'month'],
      [/पिछले\s*(?:साल|वर्ष)/u, 'year'],
    ],
    ago: [
      [/(\d+)\s*दिन\s*पहले/u, 'day'],
      [/(\d+)\s*(?:हफ्ते|सप्ताह)\s*पहले/u, 'week'],
      [/(\d+)\s*(?:महीने|माह)\s*पहले/u, 'month'],
      [/(\d+)\s*(?:साल|वर्ष)\s*पहले/u, 'year'],
    ],
  },
  ar: {
    fixed: [
      [/أول\s*أمس|أمس\s*الأول|قبل\s*يومين/u, -2],
      [/أمس|البارحة/u, -1],
      [/اليوم/u, 0],
    ],
    lastUnit: [
      [/الأسبوع\s*الماضي/u, 'week'],
      [/الشهر\s*الماضي/u, 'month'],
      [/العام\s*الماضي|السنة\s*الماضية/u, 'year'],
    ],
    ago: [
      [/(?:قبل|منذ)\s*(\d+)\s*(?:يوم|أيام|يوما|يومًا|يوماً)/u, 'day'],
      [/(?:قبل|منذ)\s*(\d+)\s*(?:أسبوع|أسابيع|أسبوعا|أسبوعًا)/u, 'week'],
      [/(?:قبل|منذ)\s*(\d+)\s*(?:شهر|أشهر|شهور|شهرا|شهرًا)/u, 'month'],
      [/(?:قبل|منذ)\s*(\d+)\s*(?:سنة|سنوات|سنين|عام|أعوام|عاما|عامًا)/u, 'year'],
    ],
  },
};

/** Subtract N whole units from a UTC-midnight anchor (calendar-correct for
 *  month/year via the UTC setters). */
function subtractUnits(anchor: Date, n: number, unit: RelUnit): Date {
  const d = new Date(anchor.getTime());
  if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

/**
 * Resolve an ar/hi/ko relative expression against a local-day anchor, or null.
 * Precedence: explicit "N <unit> ago" (most specific) → fixed day phrases →
 * "last <unit>". Returns UTC-midnight of the resolved calendar day.
 */
function parseRelativeGrammar(
  lang: string,
  clause: string,
  anchor: Date,
): { date: Date; expr: string } | null {
  const g = REL_GRAMMARS[lang];
  if (!g) return null;
  const text = normalizeDigits(clause);
  for (const [re, unit] of g.ago) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) {
        return { date: subtractUnits(anchor, n, unit), expr: m[0] };
      }
    }
  }
  for (const [re, days] of g.fixed) {
    const m = text.match(re);
    if (m) return { date: subtractUnits(anchor, -days, 'day'), expr: m[0] };
  }
  for (const [re, unit] of g.lastUnit) {
    const m = text.match(re);
    if (m) return { date: subtractUnits(anchor, 1, unit), expr: m[0] };
  }
  return null;
}

/**
 * Resolve the occurrence date referenced by `clause`, relative to the message
 * time `anchorIso`. Returns null when the clause carries no confident relative
 * time expression (caller keeps the message time).
 */
export function resolveEventTime(
  clause: string | undefined,
  anchorIso: string | Date,
  opts: ResolveEventTimeOptions = {},
): EventTime | null {
  if (!clause || !clause.trim()) return null;
  const anchorRaw = anchorIso instanceof Date ? anchorIso : new Date(anchorIso);
  if (Number.isNaN(anchorRaw.getTime())) return null;

  // Locale-time decomposition (MULTILINGUAL_TEMPORAL). Off ⇒ the legacy
  // UTC-day anchor and raw chrono reference — byte-identical. On with a
  // timeZone ⇒ the anchor is the speaker's LOCAL calendar day (day-shift fix)
  // and chrono resolves against local-day noon (host-tz-independent).
  const localeOn = opts.localeTime === true;
  const tz = localeOn && opts.timeZone ? opts.timeZone : undefined;
  const anchor = tz ? atLocaleMidnight(anchorRaw, tz) : atUtcMidnight(anchorRaw);
  const chronoRef = tz ? localeNoonUtc(anchorRaw, tz) : anchorRaw;

  const lang = opts.lang ?? (detectLanguage(clause).language || 'und');

  // ar/hi/ko relative expressions — scripts chrono has no parser for, which
  // otherwise fall through to the English parser and silently miss. Gated by
  // localeTime so the off path is unchanged.
  if (localeOn) {
    const rel = parseRelativeGrammar(lang, clause, anchor);
    if (rel) {
      const clamped = clampPast(rel.date, anchor);
      if (clamped) return { date: clamped, expr: rel.expr };
    }
  }

  const langKey = PARSERS[lang] ? lang : 'en';

  // chrono first (relative expressions, multilingual), English as a secondary
  // pass for a non-English clause that embeds a language-agnostic date.
  const primary = PARSERS[langKey];
  const english = PARSERS.en;
  const hit =
    (primary ? parseWith(primary, clause, chronoRef) : null) ??
    (langKey !== 'en' && english ? parseWith(english, clause, chronoRef) : null);
  if (hit) {
    const clamped = clampPast(hit.date, anchor);
    if (clamped) return { date: clamped, expr: hit.expr };
  }

  // Fallback: explicit past year chrono didn't resolve.
  const yr = clause.match(YEAR_FALLBACK);
  if (yr) {
    const year = parseInt(yr[1]!, 10); // group 1 is mandatory on match
    if (year < anchor.getUTCFullYear()) {
      const clamped = clampPast(new Date(Date.UTC(year, 0, 1)), anchor);
      if (clamped) return { date: clamped, expr: `year ${year}` };
    }
  }
  return null;
}

/** Run one chrono parser; return the first result carrying a real date, rolled
 *  back a year if it landed in the future (a bare "12 September" resolves to the
 *  nearest occurrence, which our past-only semantics must not accept forward). */
function parseWith(
  parser: ChronoLike,
  clause: string,
  ref: Date,
): { date: Date; expr: string } | null {
  let results: Array<{ text: string; start: { date(): Date } }>;
  try {
    // forwardDate:false — default past bias for weekdays ("last Friday" → the
    // previous one), matching the "already happened" semantics.
    results = parser.parse(clause, ref, { forwardDate: false });
  } catch {
    return null;
  }
  for (const r of results) {
    let d = r.start.date();
    if (Number.isNaN(d.getTime())) continue;
    if (d.getTime() > ref.getTime()) {
      // Future → roll back one year (bare-date nearest-occurrence case).
      const rolled = new Date(d);
      rolled.setUTCFullYear(rolled.getUTCFullYear() - 1);
      d = rolled;
      if (d.getTime() > ref.getTime()) continue;
    }
    return { date: d, expr: r.text };
  }
  return null;
}

/** Floor to UTC midnight and enforce the past + lookback window. */
function clampPast(d: Date, anchor: Date): Date | null {
  const day = atUtcMidnight(d);
  if (Number.isNaN(day.getTime())) return null;
  if (day.getTime() > anchor.getTime()) return null;
  const min = new Date(anchor);
  min.setUTCFullYear(min.getUTCFullYear() - MAX_LOOKBACK_YEARS);
  if (day.getTime() < min.getTime()) return null;
  return day;
}
