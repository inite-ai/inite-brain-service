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
