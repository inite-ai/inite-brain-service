import type { QueryTimeRange } from './scoring';

/**
 * V13 time-constrained retrieval (RETRIEVAL_TIME_FILTER) — the query
 * period parser. Code-side and regex-only: no LLM call, no locale
 * heuristics beyond English month names (the eval axes and the
 * dialogue tract are English; an unparseable query simply returns
 * null and ranking is byte-identical).
 *
 * Deliberately conservative: only ABSOLUTE periods parse — an explicit
 * day (ISO or spelled), a month with a year, a bare year, or a
 * between-range of those. Month names without a year, relative
 * expressions ("last summer", "two weeks ago") and bare day numbers
 * return null: a wrong period anchor would demote the right facts,
 * and the measured cost of that class (armK −4.9) is worse than no
 * anchor at all.
 */

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};
const MONTH_ALTS =
  'january|february|march|april|may|june|july|august|september|october|november|december';

/** `2023-05-07` — ISO day. */
const ISO_DAY_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
/** `7 May 2023` / `7th of May, 2023`. */
const DAY_MONTH_YEAR_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_ALTS})\\s*,?\\s+(\\d{4})\\b`,
  'gi',
);
/** `May 7, 2023` / `May 7th 2023`. */
const MONTH_DAY_YEAR_RE = new RegExp(
  `\\b(${MONTH_ALTS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b`,
  'gi',
);
/** `May 2023` (only when no day form matched the same month-year). */
const MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_ALTS})\\s*,?\\s+(\\d{4})\\b`, 'gi');
/** Bare years, sanity-bounded to the conversational era. */
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

const DAY_MS = 86_400_000;

function dayStartMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m, d);
}

function collect(re: RegExp, text: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

function validDay(y: number, m: number, d: number): boolean {
  return m >= 0 && m <= 11 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100;
}

/** Envelope of [from, to) intervals; null when the list is empty. */
function envelope(spans: Array<[number, number]>): QueryTimeRange | null {
  if (spans.length === 0) return null;
  return {
    fromMs: Math.min(...spans.map(([f]) => f)),
    toMs: Math.max(...spans.map(([, t]) => t)),
  };
}

function daySpans(query: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of collect(ISO_DAY_RE, query)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    if (validDay(y, mo, d)) {
      spans.push([dayStartMs(y, mo, d), dayStartMs(y, mo, d) + DAY_MS]);
    }
  }
  for (const m of collect(DAY_MONTH_YEAR_RE, query)) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase()], Number(m[3])];
    if (validDay(y, mo, d)) {
      spans.push([dayStartMs(y, mo, d), dayStartMs(y, mo, d) + DAY_MS]);
    }
  }
  for (const m of collect(MONTH_DAY_YEAR_RE, query)) {
    const [mo, d, y] = [MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3])];
    if (validDay(y, mo, d)) {
      spans.push([dayStartMs(y, mo, d), dayStartMs(y, mo, d) + DAY_MS]);
    }
  }
  return spans;
}

function monthSpans(query: string): Array<[number, number]> {
  return collect(MONTH_YEAR_RE, query)
    .map((m): [number, number] => {
      const mo = MONTHS[m[1].toLowerCase()];
      const y = Number(m[2]);
      return [Date.UTC(y, mo, 1), Date.UTC(y, mo + 1, 1)];
    })
    .filter(([f]) => Number.isFinite(f));
}

function yearSpans(query: string): Array<[number, number]> {
  return collect(YEAR_RE, query).map((m): [number, number] => {
    const y = Number(m[1]);
    return [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
  });
}

/**
 * The most PRECISE absolute period the query names, widened to the
 * envelope when it names several of the same precision ("between 3 May
 * 2023 and 7 May 2023" → that five-day span; "in 2022 and 2023" → the
 * two-year span). Day forms beat month forms beat bare years — a query
 * naming "7 May 2023" must not widen to the whole month its words also
 * match. Null = no absolute period → the filter is inert.
 */
export function parseQueryTimeRange(query: string): QueryTimeRange | null {
  const days = daySpans(query);
  if (days.length > 0) return envelope(days);
  const months = monthSpans(query);
  if (months.length > 0) return envelope(months);
  return envelope(yearSpans(query));
}
