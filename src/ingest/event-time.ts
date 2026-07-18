/**
 * Event-time resolution — lift the *occurrence* date of an episodic fact out
 * of the relative temporal expression in its clause, instead of stamping the
 * message time.
 *
 * Why this exists: mention ingest sets a fact's `validFrom` to `dto.emittedAt`
 * (when the sentence was SAID). But conversational statements routinely refer
 * to when something HAPPENED, in the past, relative to now: "I went to the
 * support group *yesterday*", "I painted that *last year*", "the pottery
 * workshop *last Friday*". Stamping the message time makes every such fact
 * land one day / one year / one week late, which is precisely the systematic
 * offset LoCoMo "when did X" questions punish (gold "7 May" vs answer "8 May").
 *
 * This resolver is deliberately deterministic (regex over the clause anchored
 * on the message date) rather than an LLM contract change: it keeps the
 * extraction schema, grounding, and semantic-entropy clustering untouched, so
 * the blast radius is one flag-gated call at persist time. It covers the
 * common conversational forms; anything it can't confidently resolve returns
 * null and the caller falls back to the message time — never a guess.
 *
 * Enabled by `INGEST_EVENT_TIME_EXTRACTION` (default off; re-ingest to apply).
 */

/** Sanity window: an event referenced in conversation is in the past, and we
 *  won't trust a resolved date more than this far back (guards a bare-year
 *  false positive from rewriting validFrom to 1998). */
const MAX_LOOKBACK_YEARS = 25;

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
};

export interface EventTime {
  /** Resolved occurrence date (UTC midnight). */
  date: Date;
  /** The matched expression, for tracing ("yesterday", "last friday", …). */
  expr: string;
}

function atUtcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

/** Prior occurrence of `weekday` strictly before (or on) the anchor. "last
 *  Friday" / "the Friday before" → the most recent past Friday. If the anchor
 *  itself is that weekday we step back a full week (you don't say "last Friday"
 *  about today). */
function priorWeekday(anchor: Date, weekday: number): Date {
  let delta = (anchor.getUTCDay() - weekday + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(anchor, -delta);
}

/**
 * Resolve the occurrence date referenced by `clause`, relative to the message
 * time `anchorIso`. Returns null when the clause carries no confident relative
 * time expression (caller keeps the message time). Patterns are ordered most-
 * specific first so "3 weeks ago" wins over a bare year in the same clause.
 */
export function resolveEventTime(
  clause: string | undefined,
  anchorIso: string | Date,
): EventTime | null {
  if (!clause) return null;
  const anchorRaw = anchorIso instanceof Date ? anchorIso : new Date(anchorIso);
  if (Number.isNaN(anchorRaw.getTime())) return null;
  const anchor = atUtcMidnight(anchorRaw);
  const text = clause.toLowerCase();

  const clamp = (d: Date, expr: string): EventTime | null => {
    const day = atUtcMidnight(d);
    // Future or same-second-future dates are never an "occurred" reference.
    if (day.getTime() > anchor.getTime()) return null;
    const minMs = addMonths(anchor, -12 * MAX_LOOKBACK_YEARS).getTime();
    if (day.getTime() < minMs) return null;
    return { date: day, expr };
  };

  // 1. day-before-yesterday / yesterday (highest-frequency, highest-value).
  if (/\bday before yesterday\b/.test(text)) {
    return clamp(addDays(anchor, -2), 'day before yesterday');
  }
  if (/\byesterday\b/.test(text)) {
    return clamp(addDays(anchor, -1), 'yesterday');
  }

  // 2. "N <unit> ago" and "a/an <unit> ago".
  const agoNum = text.match(
    /\b(\d+)\s+(day|week|month|year)s?\s+ago\b/,
  );
  if (agoNum) {
    const n = parseInt(agoNum[1], 10);
    const unit = agoNum[2];
    if (unit === 'month') return clamp(addMonths(anchor, -n), `${n} months ago`);
    if (unit === 'year') return clamp(addMonths(anchor, -12 * n), `${n} years ago`);
    return clamp(addDays(anchor, -n * UNIT_DAYS[unit]), `${n} ${unit}s ago`);
  }
  const agoA = text.match(/\b(?:a|an|one)\s+(day|week|month|year)\s+ago\b/);
  if (agoA) {
    const unit = agoA[1];
    if (unit === 'month') return clamp(addMonths(anchor, -1), 'a month ago');
    if (unit === 'year') return clamp(addMonths(anchor, -12), 'a year ago');
    return clamp(addDays(anchor, -UNIT_DAYS[unit]), `a ${unit} ago`);
  }

  // 3. "last / this past <weekday>" and "the <weekday> before".
  const wd = text.match(
    /\b(?:last|this past|the)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?:\s+before)?/,
  );
  if (wd) {
    return clamp(priorWeekday(anchor, WEEKDAYS[wd[1]]), `last ${wd[1]}`);
  }

  // 4. "last week / month / year" (coarse; approximates to one unit back).
  if (/\b(?:last|this past)\s+week\b/.test(text) || /\bthe week before\b/.test(text)) {
    return clamp(addDays(anchor, -7), 'last week');
  }
  if (/\b(?:last|this past)\s+month\b/.test(text) || /\bthe month before\b/.test(text)) {
    return clamp(addMonths(anchor, -1), 'last month');
  }
  if (/\b(?:last|this past)\s+year\b/.test(text)) {
    // "last year" → Jan 1 of the prior year: a year-granular reference, so we
    // pin to the year boundary rather than an exact -365d (which drifts into
    // the wrong year near January).
    return clamp(
      new Date(Date.UTC(anchor.getUTCFullYear() - 1, 0, 1)),
      'last year',
    );
  }

  // 5. Bare explicit year in the clause ("since 2016", "back in 2022"). Last
  //    resort — only a 4-digit year strictly earlier than the anchor's year,
  //    pinned to that year's Jan 1. Guards against matching the anchor year
  //    (that's not a past reference) and future years.
  const yr = text.match(/\b(19|20)\d{2}\b/);
  if (yr) {
    const year = parseInt(yr[0], 10);
    if (year < anchor.getUTCFullYear()) {
      return clamp(new Date(Date.UTC(year, 0, 1)), `year ${year}`);
    }
  }

  return null;
}
