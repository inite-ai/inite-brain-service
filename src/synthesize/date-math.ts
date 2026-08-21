import type { SearchHit } from '../search/search.types';

/**
 * V13 deterministic date arithmetic (RETRIEVAL_DATE_MATH) — the
 * computed date table. Mini-class generators measure 14-40% on raw
 * calendar offsets with typical errors above 100 days (PRIMETIME), so
 * weekday resolution and event-to-event gaps are computed HERE, in
 * code, and rendered next to the facts.
 *
 * Frame guard: the measured anti-pattern on the LME temporal axis was
 * the "[elapsed: N days before today]" distance-to-TODAY frame, which
 * actively misleads event-to-event questions. This table renders
 * event-to-event deltas only (each date's gap to the previous dated
 * evidence); no line references "today".
 */

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Distinct calendar days the table renders, newest evidence first cap. */
const DATE_TABLE_CAP = 12;

const DAY_MS = 86_400_000;

/** Epoch sentinel = "undated" convention — never a real evidence date.
 *  Only the sentinel's OWN calendar day is excluded; genuine pre-1970
 *  history stays renderable (audit 2026-08-19: `ms > DAY_MS` dropped
 *  every date up to 1970-01-02). */
function isRealDate(ms: number): boolean {
  return Number.isFinite(ms) && Math.floor(ms / DAY_MS) !== 0;
}

function collectDayMs(hits: SearchHit[]): number[] {
  const days = new Set<number>();
  for (const h of hits) {
    for (const f of h.facts) {
      for (const raw of [f.validFrom, f.validUntil, f.mentionedAt]) {
        if (!raw) continue;
        const ms = Date.parse(String(raw));
        if (!isRealDate(ms)) continue;
        days.add(Math.floor(ms / DAY_MS) * DAY_MS);
      }
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * One line per distinct evidence day, chronological: the weekday plus
 * the exact gap to the previous dated line. Empty when fewer than one
 * dated fact survives — the section is omitted, byte-identical prompt.
 */
export function buildDateMathLines(hits: SearchHit[]): string[] {
  let days = collectDayMs(hits);
  if (days.length === 0) return [];
  // The cap keeps the NEWEST days: recency mirrors the evidence the
  // budget already prefers, and the chronological render stays intact.
  if (days.length > DATE_TABLE_CAP) days = days.slice(-DATE_TABLE_CAP);
  return days.map((ms, i) => {
    const d = new Date(ms);
    const iso = d.toISOString().slice(0, 10);
    const weekday = WEEKDAYS[d.getUTCDay()];
    if (i === 0) return `${iso} = ${weekday}`;
    const prev = new Date(days[i - 1]);
    const gap = Math.round((ms - days[i - 1]) / DAY_MS);
    return `${iso} = ${weekday}, ${gap} day${gap === 1 ? '' : 's'} after ${prev.toISOString().slice(0, 10)}`;
  });
}
