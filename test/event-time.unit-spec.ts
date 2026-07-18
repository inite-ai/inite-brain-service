import { resolveEventTime } from '../src/ingest/event-time';

/**
 * Event-time resolution — lifts the occurrence date out of a clause's relative
 * temporal expression, anchored on the message time. Cases mirror the actual
 * LoCoMo "when did X" failures where validFrom=message-time landed the answer
 * one day / year / week late.
 */
describe('resolveEventTime', () => {
  const iso = (d: string) => `${d}T12:00:00Z`;
  const ymd = (e: { date: Date } | null) =>
    e ? e.date.toISOString().slice(0, 10) : null;

  it('yesterday → anchor minus one day (the +1-day offset bug)', () => {
    // "I went to a LGBTQ support group yesterday" said on 8 May → event 7 May.
    expect(ymd(resolveEventTime('went to a support group yesterday', iso('2023-05-08'))))
      .toBe('2023-05-07');
  });

  it('day before yesterday → anchor minus two days', () => {
    expect(ymd(resolveEventTime('the day before yesterday I flew home', iso('2023-05-08'))))
      .toBe('2023-05-06');
  });

  it('last year → Jan 1 of the prior year (year-granular)', () => {
    // "I painted that lake sunrise last year" said in 2023 → 2022.
    const r = resolveEventTime('painted that lake sunrise last year', iso('2023-05-08'));
    expect(r?.date.getUTCFullYear()).toBe(2022);
  });

  it('N days/weeks/months/years ago', () => {
    expect(ymd(resolveEventTime('signed the lease 3 days ago', iso('2023-07-10')))).toBe('2023-07-07');
    expect(ymd(resolveEventTime('we met 2 weeks ago', iso('2023-07-15')))).toBe('2023-07-01');
    expect(resolveEventTime('started it 6 months ago', iso('2023-07-15'))?.date.getUTCMonth()).toBe(0); // Jan
    expect(resolveEventTime('graduated 5 years ago', iso('2023-07-15'))?.date.getUTCFullYear()).toBe(2018);
  });

  it('a/an <unit> ago', () => {
    expect(ymd(resolveEventTime('a week ago I ran a race', iso('2023-05-25')))).toBe('2023-05-18');
    expect(resolveEventTime('a year ago', iso('2023-05-25'))?.date.getUTCFullYear()).toBe(2022);
  });

  it('last <weekday> / the <weekday> before → the prior occurrence', () => {
    // 2023-07-15 is a Saturday. "the Friday before" → 2023-07-14.
    expect(ymd(resolveEventTime('the pottery workshop the Friday before', iso('2023-07-15'))))
      .toBe('2023-07-14');
    // "last Tuesday" from Sat 15 Jul → 11 Jul.
    expect(ymd(resolveEventTime('had it last Tuesday', iso('2023-07-15')))).toBe('2023-07-11');
  });

  it('same weekday as anchor steps back a full week (not "today")', () => {
    // 2023-07-15 is Saturday; "last Saturday" means the previous one, 8 Jul.
    expect(ymd(resolveEventTime('last Saturday', iso('2023-07-15')))).toBe('2023-07-08');
  });

  it('last week / the week before → seven days back', () => {
    expect(ymd(resolveEventTime('went camping last week', iso('2023-06-27')))).toBe('2023-06-20');
    expect(ymd(resolveEventTime('the week before we hiked', iso('2023-06-27')))).toBe('2023-06-20');
  });

  it('last month → one calendar month back', () => {
    expect(resolveEventTime('moved last month', iso('2023-07-15'))?.date.getUTCMonth()).toBe(5); // June
  });

  it('bare explicit year in the clause ("since 2016")', () => {
    expect(resolveEventTime('practicing art since 2016', iso('2023-07-15'))?.date.getUTCFullYear())
      .toBe(2016);
  });

  it('does NOT match the anchor year or a future year (not a past reference)', () => {
    expect(resolveEventTime('planning for 2023', iso('2023-07-15'))).toBeNull();
    expect(resolveEventTime('excited about 2025', iso('2023-07-15'))).toBeNull();
  });

  it('returns null when there is no relative expression (caller keeps msg time)', () => {
    expect(resolveEventTime('Caroline is a transgender woman', iso('2023-05-08'))).toBeNull();
    expect(resolveEventTime('loves hiking and painting', iso('2023-05-08'))).toBeNull();
    expect(resolveEventTime(undefined, iso('2023-05-08'))).toBeNull();
    expect(resolveEventTime('', iso('2023-05-08'))).toBeNull();
  });

  it('never resolves to a future date even if the arithmetic would', () => {
    // guard: a bad anchor shouldn\'t produce a forward date.
    expect(resolveEventTime('yesterday', 'not-a-date')).toBeNull();
  });

  it('most-specific pattern wins over a bare year in the same clause', () => {
    // "3 days ago ... in 2016" — the explicit offset should win.
    expect(ymd(resolveEventTime('renewed it 3 days ago, first signed in 2016', iso('2023-07-10'))))
      .toBe('2023-07-07');
  });

  it('clamps absurd lookback (bare year older than 25y) to null', () => {
    expect(resolveEventTime('born in 1975', iso('2023-07-15'))).toBeNull();
  });
});
