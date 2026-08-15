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
}

function atUtcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
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
  const anchor = atUtcMidnight(anchorRaw);

  const lang = opts.lang ?? (detectLanguage(clause).language || 'und');
  const langKey = PARSERS[lang] ? lang : 'en';

  // chrono first (relative expressions, multilingual), English as a secondary
  // pass for a non-English clause that embeds a language-agnostic date.
  const hit =
    parseWith(PARSERS[langKey], clause, anchorRaw) ??
    (langKey !== 'en' ? parseWith(PARSERS.en, clause, anchorRaw) : null);
  if (hit) {
    const clamped = clampPast(hit.date, anchor);
    if (clamped) return { date: clamped, expr: hit.expr };
  }

  // Fallback: explicit past year chrono didn't resolve.
  const yr = clause.match(YEAR_FALLBACK);
  if (yr) {
    const year = parseInt(yr[1], 10);
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
