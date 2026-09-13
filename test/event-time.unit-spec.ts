import { resolveEventTime } from '../src/ingest/event-time';

/**
 * Event-time resolution (chrono-node backed, multilingual). Anchored on the
 * message time, biased to the past. Cases mirror the actual LoCoMo "when did X"
 * failures plus Russian, plus the false-positive rejections that motivated
 * moving off hand-rolled regexes.
 */
describe('resolveEventTime', () => {
  // 2023-05-08 is a Monday.
  const ref = '2023-05-08T13:56:00Z';
  const ymd = (e: { date: Date } | null) => (e ? e.date.toISOString().slice(0, 10) : null);

  describe('English relative expressions', () => {
    it('yesterday → anchor minus one day (the +1-day offset bug)', () => {
      expect(
        ymd(resolveEventTime('went to the support group yesterday', ref, { lang: 'en' })),
      ).toBe('2023-05-07');
    });
    it('the day before yesterday', () => {
      expect(
        ymd(resolveEventTime('the day before yesterday I flew home', ref, { lang: 'en' })),
      ).toBe('2023-05-06');
    });
    it('last year → prior year', () => {
      expect(
        resolveEventTime('painted that sunrise last year', ref, {
          lang: 'en',
        })?.date.getUTCFullYear(),
      ).toBe(2022);
    });
    it('N weeks ago', () => {
      expect(ymd(resolveEventTime('signed up 3 weeks ago', ref, { lang: 'en' }))).toBe(
        '2023-04-17',
      );
    });
    it('last <weekday> → the prior occurrence', () => {
      // Monday 8 May → last Friday = 5 May.
      expect(ymd(resolveEventTime('the pottery workshop last Friday', ref, { lang: 'en' }))).toBe(
        '2023-05-05',
      );
    });
  });

  describe('Russian (chrono.ru, built-in)', () => {
    it('вчера → minus one day', () => {
      expect(ymd(resolveEventTime('ходил в группу вчера', ref, { lang: 'ru' }))).toBe('2023-05-07');
    });
    it('позавчера → minus two days', () => {
      expect(ymd(resolveEventTime('это было позавчера', ref, { lang: 'ru' }))).toBe('2023-05-06');
    });
    it('три недели назад', () => {
      expect(ymd(resolveEventTime('купил три недели назад', ref, { lang: 'ru' }))).toBe(
        '2023-04-17',
      );
    });
    it('в прошлом году → prior year', () => {
      expect(
        resolveEventTime('в прошлом году переехал', ref, { lang: 'ru' })?.date.getUTCFullYear(),
      ).toBe(2022);
    });
    it('в прошлую пятницу → prior Friday', () => {
      expect(ymd(resolveEventTime('это было в прошлую пятницу', ref, { lang: 'ru' }))).toBe(
        '2023-05-05',
      );
    });
  });

  describe('explicit-year fallback (chrono leaves it unparsed)', () => {
    it('EN "since 2016"', () => {
      expect(
        resolveEventTime('practicing art since 2016', ref, { lang: 'en' })?.date.getUTCFullYear(),
      ).toBe(2016);
    });
    it('RU "в 2016"', () => {
      expect(resolveEventTime('начал в 2016', ref, { lang: 'ru' })?.date.getUTCFullYear()).toBe(
        2016,
      );
    });
    it('does not accept the anchor year or a future year', () => {
      expect(resolveEventTime('planning for 2025', ref, { lang: 'en' })).toBeNull();
      expect(resolveEventTime('goals in 2023', ref, { lang: 'en' })).toBeNull();
    });
  });

  describe('false-positive rejection (the win over bare regexes)', () => {
    it('a bare number is not a date', () => {
      expect(resolveEventTime('I ran 2000 meters', ref, { lang: 'en' })).toBeNull();
      expect(resolveEventTime('meeting in room 2015 downstairs', ref, { lang: 'en' })).toBeNull();
      expect(resolveEventTime('scored 2016 points', ref, { lang: 'en' })).toBeNull();
    });
    it('a stative fact with no temporal expression → null', () => {
      expect(resolveEventTime('Caroline is a transgender woman', ref, { lang: 'en' })).toBeNull();
      expect(resolveEventTime('loves hiking and painting', ref, { lang: 'en' })).toBeNull();
    });
    it('empty / undefined clause → null', () => {
      expect(resolveEventTime(undefined, ref)).toBeNull();
      expect(resolveEventTime('', ref)).toBeNull();
      expect(resolveEventTime('   ', ref)).toBeNull();
    });
  });

  describe('robustness', () => {
    it('never resolves to the future (bad anchor → null)', () => {
      expect(resolveEventTime('yesterday', 'not-a-date', { lang: 'en' })).toBeNull();
    });
    it('clamps an absurd lookback to null', () => {
      // "in 1975" is > 25y before 2023 → rejected.
      expect(resolveEventTime('born in 1975', ref, { lang: 'en' })).toBeNull();
    });
    it('auto-detects language when lang is not given', () => {
      // no lang hint → detector picks ru, chrono.ru resolves.
      expect(ymd(resolveEventTime('ходил в группу вчера', ref))).toBe('2023-05-07');
      expect(ymd(resolveEventTime('went there yesterday', ref))).toBe('2023-05-07');
    });
    it('unsupported language falls back to English parsing', () => {
      expect(ymd(resolveEventTime('went there yesterday', ref, { lang: 'ko' }))).toBe('2023-05-07');
    });
  });
});

/**
 * A STATED year is an assertion, not an inference.
 *
 * `parseWith` rolls a parsed date back one year when it lands after the
 * reference — right for a bare "12 September", where chrono picks a
 * nearest occurrence that may fall forward. Applied to a date that names
 * its own year it invented a date the text never contained, and because
 * chrono resolves a date-only expression to MIDDAY, a date on the SAME
 * DAY as the message already compared as future and was rolled back a
 * full year.
 *
 * Observed on a battery tenant (6 facts, one rule):
 *
 *   turn emittedAt 2026-03-10T10:10Z, text "Root cause found (2026-03-10)"
 *     -> validFrom 2025-03-10T00:00:00Z
 *
 * and the same for every stated date at or after its own message instant
 * (`changed_launch_date` 2025-04-15, `on_track_for` 2025-05-06,
 * `payout_cutoff` 2025-03-25, `cutoff_time` 2025-04-02). The answer it
 * produced was "identified on 2025-03-10", which is why the temporal
 * dimension failed on a date the corpus states outright.
 */
describe('stated years are never rewritten', () => {
  const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10);

  it('a date on the SAME DAY as the message keeps its year', () => {
    // The exact repro. Midday-vs-10:10 is what used to make it "future".
    const out = resolveEventTime(
      'Root cause found (2026-03-10): the retry handler re-enqueued payout jobs.',
      '2026-03-10T10:10:00Z',
    );
    expect(ymd(out?.date)).toBe('2026-03-10');
  });

  it('a stated PAST date still resolves to itself', () => {
    const out = resolveEventTime(
      'payout PA-1077 was paid twice on 2026-03-08',
      '2026-03-10T10:10:00Z',
    );
    expect(ymd(out?.date)).toBe('2026-03-08');
  });

  it('a stated FUTURE date resolves to nothing — never to last year', () => {
    // "the launch is 2026-04-15" said in March: the date named is the
    // VALUE, not the moment the statement became true, so the caller
    // keeps the message time. The one thing it must never be is 2025.
    const out = resolveEventTime('we moved the pilot launch to 2026-04-15', '2026-03-18T09:00:00Z');
    expect(ymd(out?.date)).not.toBe('2025-04-15');
    if (out) expect(out.date.getTime()).toBeLessThanOrEqual(Date.parse('2026-03-18T00:00:00Z'));
  });

  it('a BARE date still rolls back — the case the rollback exists for', () => {
    // No year in the text, and the nearest occurrence is forward of the
    // reference, so the past-only reading is last year's.
    const out = resolveEventTime('we shipped it on December 20', '2026-03-10T10:10:00Z');
    expect(ymd(out?.date)).toBe('2025-12-20');
  });

  it('relative expressions are untouched', () => {
    expect(ymd(resolveEventTime('I saw them yesterday', '2026-03-10T10:10:00Z')?.date)).toBe(
      '2026-03-09',
    );
  });
});

/**
 * A TIME OF DAY is not an event date.
 *
 * "the payout cutoff is 16:30 UTC" states a property of a schedule and
 * says nothing about when anything happened — but chrono answers with a
 * full instant: the time from the text, the date silently borrowed from
 * the reference. Stamping `validFrom` from that is a category error, and
 * it compounded: 16:30 is later in the day than a 14:35 message, so the
 * result read as "future" and the year rollback aged it by one.
 *
 * Four facts on a battery tenant carried 2025 stamps from exactly this —
 * two payout-cutoff turns whose text contains no date at all.
 */
describe('time-of-day expressions carry no event date', () => {
  const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10);

  it.each([
    'the payout cutoff is 16:30 UTC',
    'That contradicts what Priya was told (17:00 UTC).',
    'the Meridian payout cutoff discrepancy (Priya: 17:00 UTC vs docs v2.3: 16:30 UTC)',
  ])('resolves nothing for: %s', (text) => {
    expect(resolveEventTime(text, '2026-03-25T14:35:00Z')).toBeNull();
  });

  it('a time TOGETHER WITH a date still resolves to the date', () => {
    const out = resolveEventTime(
      'the incident started on 2026-03-08 at 16:30 UTC',
      '2026-03-25T14:35:00Z',
    );
    expect(ymd(out?.date)).toBe('2026-03-08');
  });

  it('relative expressions are unaffected (they state a date)', () => {
    expect(ymd(resolveEventTime('three weeks ago', '2026-03-25T14:35:00Z')?.date)).toBe(
      '2026-03-04',
    );
    expect(ymd(resolveEventTime('I saw them yesterday', '2026-03-25T14:35:00Z')?.date)).toBe(
      '2026-03-24',
    );
  });
});
