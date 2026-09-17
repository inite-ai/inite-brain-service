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
import { traceArtifact } from '../common/debug-trace';
import { envFlagEnabled } from '../common/env-validation';
import { normalizeDigits } from '../common/locale-digits';
import { parseLocaleAbsoluteDate } from './locale-date';

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
  ): Array<{
    text: string;
    /** `isCertain` distinguishes a component the TEXT stated from one
     *  chrono inferred from the reference instant — the difference
     *  between "2026-03-10" and a bare "12 September". Optional so the
     *  structural type still matches a stub parser in tests. */
    start: { date(): Date; isCertain?(component: string): boolean };
  }>;
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
/** Components whose certainty means "the text stated a DATE". `hour` /
 *  `minute` are deliberately absent: a time of day borrows its calendar
 *  day from the reference instant and carries no event date of its own. */
const DATE_COMPONENTS = ['year', 'month', 'day', 'weekday'] as const;

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
   * IANA timezone of the speaker's session (e.g. 'Asia/Tokyo'). Fixes the
   * atUtcMidnight day-shift: a message emitted near a UTC day boundary is
   * anchored to the speaker's LOCAL calendar day, so "yesterday" resolves
   * against the day they actually saw, not the UTC day. Absent or unknown ⇒
   * the UTC-day behavior (never throws). The stored date stays
   * language-neutral ISO-8601 (UTC-midnight of the resolved calendar day).
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

  // With a session timezone the anchor is the speaker's LOCAL calendar day
  // (the day-shift fix) and chrono resolves against local-day noon, which is
  // host-timezone-independent. Without one, the UTC day.
  const tz = opts.timeZone;
  const anchor = tz ? atLocaleMidnight(anchorRaw, tz) : atUtcMidnight(anchorRaw);
  const chronoRef = tz ? localeNoonUtc(anchorRaw, tz) : anchorRaw;

  const lang = opts.lang ?? (detectLanguage(clause).language || 'und');

  // ar/hi/ko relative expressions — scripts chrono has no parser for, which
  // otherwise fall through to the English parser and silently miss. Runs
  // unconditionally: REL_GRAMMARS is keyed by language, so for every other
  // clause this is a map lookup that misses and costs nothing, and for an
  // Arabic one the alternative is not "legacy behavior" but a silent miss.
  const rel = parseRelativeGrammar(lang, clause, anchor);
  if (rel) {
    const clamped = clampPast(rel.date, anchor);
    if (clamped) return { date: clamped, expr: rel.expr };
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

  // An explicit `day month-name year` in a locale chrono has no parser for.
  // chrono covers thirteen languages; everything else was falling to the
  // English parser, which reads nothing in a non-Latin script, and the caller
  // then stamped the message time — "٣ مارس ٢٠٢٦" came back as the day the
  // sentence was said, six months off, looking like an answer. The month
  // names come from ICU, so this covers every locale the platform knows
  // (ar, hi, th, he, fa, tr, id, pl, cs, uk, …) rather than the two that
  // exposed it. Conservative by construction: see locale-date.ts.
  const absolute = parseLocaleAbsoluteDate(clause, lang);
  if (absolute) {
    const clamped = clampPast(absolute.date, anchor);
    if (clamped) return { date: clamped, expr: absolute.expr };
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
  let results: ReturnType<ChronoLike['parse']>;
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
    const certain = (c: string): boolean => r.start.isCertain?.(c) === true;
    // A TIME OF DAY is not an event date. "the payout cutoff is 16:30
    // UTC" states a property of a schedule and says nothing about when
    // anything happened, but chrono answers with a full instant: the
    // time from the text, the date silently borrowed from the reference.
    // Stamping validFrom from that is a category error, and it compounds
    // — 16:30 is later in the day than a 14:35 message, so the result
    // reads as "future" and the rollback below aged it a year. Four
    // facts on a battery tenant carried 2025 stamps from exactly this:
    // two payout-cutoff turns whose text contains no date at all.
    //
    // chrono marks a component certain when the TEXT determined it and
    // implied when it came from the reference, so "no certain date
    // component" is precisely "this expression carries no date".
    // Verified against chrono directly — certain components per shape:
    //   "16:30 UTC"          hour                  <- no date at all
    //   "2026-03-10"         year, month, day
    //   "yesterday"          year, month, day
    //   "three weeks ago"    year, month, day
    //   "December 20"        month, day
    //   "last Friday"        weekday               <- a date, relatively
    //   "last month"         year, month
    //   "last year"          year
    // `weekday` earns its place in the list: "last Friday" names a day
    // without naming any calendar component, and dropping it silently
    // retired the weekday cases this module was built for.
    if (!DATE_COMPONENTS.some(certain)) continue;
    // A STATED year is an assertion, not an inference, and must never be
    // rewritten. The rollback below exists for the bare-date case ("12
    // September"), where chrono picks a nearest occurrence that may land
    // forward; applied to "2026-03-10" it invents a date the text never
    // contained. Measured on a battery tenant: 6 facts stamped a year
    // early — `identified_root_cause` at 2025-03-10 from a turn whose
    // text reads "Root cause found (2026-03-10)", and the same for every
    // stated date at or after its own message instant. Note "at": chrono
    // resolves a date-only expression to midday, so a date on the SAME
    // day as the message already compares as future and was rolled back
    // a full year.
    //
    // With the year stated we simply hand the date on. clampPast then
    // decides honestly: same-day or earlier is kept, a genuinely future
    // date is refused (null), and the caller keeps the message time —
    // which is the right validFrom for "the launch is 2026-04-15" said
    // in March anyway. The date named there is the VALUE, not the moment
    // the statement became true.
    const yearStated = certain('year');
    if (!yearStated && d.getTime() > ref.getTime()) {
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

/** Resolved event-time knobs for one ingest, computed once per persist. */
export interface EventTimeResolveOpts {
  /** INGEST_EVENT_TIME_EXTRACTION — resolve occurrence dates at all. */
  on: boolean;
  /** IANA session timezone — anchors the speaker's local day. */
  timeZone?: string;
}

/**
 * Read the event-time knobs for an ingest. There is no second flag: the
 * locale half of the resolver is keyed by the clause's own language and
 * the speaker's own timezone, both of which are inputs, not switches.
 */
export function resolveEventTimeOpts(timeZone: string | undefined): EventTimeResolveOpts {
  return {
    on: envFlagEnabled(process.env.INGEST_EVENT_TIME_EXTRACTION),
    ...(timeZone ? { timeZone } : {}),
  };
}

/**
 * The fact's occurrence time. A clause often refers to when something
 * HAPPENED ("went yesterday", "painted last year", "3 марта 2026") — with
 * INGEST_EVENT_TIME_EXTRACTION on and a resolvable expression, that is
 * the date; else the message time.
 *
 * ONE function for both ingest paths. It lived inside the mention
 * persister, and the document commit — the path a stock deployment
 * actually runs mentions through (INGEST_MENTION_VIA_DOCUMENT) — stamped
 * `doc.occurredAt` on every fact. Measured with a full-chain trace on the
 * prod assembly: "Пилотный запуск запланирован на 3 марта 2026" landed as
 * validFrom = the day it was said, on the path that ships, while the
 * flag that promises otherwise was on. The temporal fixes measured on the
 * mention path were not on the conveyor.
 *
 * PROD CAVEAT (docs/operations.md): a backdated validFrom on a BITEMPORAL
 * supersede can stamp the incumbent's validUntil earlier than its own
 * validFrom (inverted interval, fact hidden from asOf). single_active is
 * guarded (INSERTED_HISTORICAL); bitemporal is not.
 */
export function factValidFrom(
  f: { predicate: string; clause?: string | undefined },
  emittedAt: string | Date,
  opts: EventTimeResolveOpts,
): Date {
  const event = opts.on
    ? resolveEventTime(f.clause, emittedAt, opts.timeZone ? { timeZone: opts.timeZone } : {})
    : null;
  if (!event) return emittedAt instanceof Date ? emittedAt : new Date(emittedAt);
  traceArtifact('ingest.fact.event_time', {
    predicate: f.predicate,
    expr: event.expr,
    resolved: event.date.toISOString().slice(0, 10),
    emittedAt: (emittedAt instanceof Date ? emittedAt.toISOString() : String(emittedAt)).slice(
      0,
      10,
    ),
  });
  return event.date;
}
