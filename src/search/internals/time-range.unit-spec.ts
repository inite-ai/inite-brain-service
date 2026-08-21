import { parseQueryTimeRange } from './time-range';

const DAY_MS = 86_400_000;

describe('parseQueryTimeRange (V13 RETRIEVAL_TIME_FILTER)', () => {
  it('parses an ISO day to a one-day span', () => {
    const r = parseQueryTimeRange('what happened on 2023-05-07?');
    expect(r).not.toBeNull();
    expect(r!.fromMs).toBe(Date.UTC(2023, 4, 7));
    expect(r!.toMs).toBe(Date.UTC(2023, 4, 7) + DAY_MS);
  });

  it('parses "7 May 2023" and "May 7th, 2023" day forms', () => {
    for (const q of [
      'the party on 7 May 2023',
      'the party on May 7th, 2023',
      'the party on 7th of May 2023',
    ]) {
      const r = parseQueryTimeRange(q);
      expect(r).not.toBeNull();
      expect(r!.fromMs).toBe(Date.UTC(2023, 4, 7));
      expect(r!.toMs - r!.fromMs).toBe(DAY_MS);
    }
  });

  it('parses a month-year to the month span', () => {
    const r = parseQueryTimeRange('what did Caroline do in May 2023?');
    expect(r).toEqual({
      fromMs: Date.UTC(2023, 4, 1),
      toMs: Date.UTC(2023, 5, 1),
    });
  });

  it('parses a bare year to the year span', () => {
    const r = parseQueryTimeRange('what changed in 2023?');
    expect(r).toEqual({
      fromMs: Date.UTC(2023, 0, 1),
      toMs: Date.UTC(2024, 0, 1),
    });
  });

  it('widens same-precision multiples to the envelope', () => {
    const r = parseQueryTimeRange('between 3 May 2023 and 7 May 2023');
    expect(r).toEqual({
      fromMs: Date.UTC(2023, 4, 3),
      toMs: Date.UTC(2023, 4, 7) + DAY_MS,
    });
  });

  it('day precision beats the month and year its words also match', () => {
    const r = parseQueryTimeRange('on 7 May 2023');
    expect(r!.toMs - r!.fromMs).toBe(DAY_MS);
  });

  it('rejects impossible calendar dates instead of normalizing them', () => {
    // Date.UTC would roll 2024-02-30 into 2024-03-01 — the filter must
    // not anchor on a DAY the query never named (audit 2026-08-19). The
    // year the words also matched still anchors the coarse fallback —
    // rank-only and honest ("some day in 2024").
    expect(parseQueryTimeRange('what happened on 2024-02-30?')).toEqual({
      fromMs: Date.UTC(2024, 0, 1),
      toMs: Date.UTC(2025, 0, 1),
    });
    // An impossible day with a real month falls back one precision
    // level — the month envelope, not the day.
    expect(parseQueryTimeRange('the party on 31 April 2023')).toEqual({
      fromMs: Date.UTC(2023, 3, 1),
      toMs: Date.UTC(2023, 4, 1),
    });
    // Real leap day parses at day precision; the impossible one falls
    // back to the year envelope.
    const leap = parseQueryTimeRange('on 29 February 2024');
    expect(leap!.toMs - leap!.fromMs).toBe(DAY_MS);
    const notLeap = parseQueryTimeRange('on 29 February 2023');
    expect(notLeap!.toMs - notLeap!.fromMs).toBeGreaterThan(DAY_MS);
  });

  it('returns null for relative or yearless expressions', () => {
    for (const q of [
      'when did Melanie paint the sunrise?',
      'what happened last summer?',
      'the trip two weeks ago',
      'the party in May', // yearless month — ambiguous, must not anchor
    ]) {
      expect(parseQueryTimeRange(q)).toBeNull();
    }
  });
});
