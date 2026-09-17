import { resolveEventTime } from '../src/ingest/event-time';

/**
 * Event-time resolution outside the languages chrono parses.
 *
 * This used to sit behind `opts.localeTime` (MULTILINGUAL_TEMPORAL), and
 * most of the file pinned that the OFF path stayed byte-identical — which
 * is to say it pinned that an Arabic or Korean speaker got nothing. The
 * flag is gone: the relative grammar is keyed by the clause's own
 * language, so for every other language it is a map lookup that misses,
 * and the session timezone is an input the caller either has or doesn't.
 * Neither is a decision an operator should be making per deployment.
 *
 * Anchors use a fixed instant; the day-shift assertions resolve against
 * the pure local-calendar-day anchor (Intl-based, host-timezone
 * independent), so they hold on any CI machine.
 */
describe('event time in languages chrono cannot parse', () => {
  const ref = '2023-05-08T13:56:00Z'; // Monday, midday UTC
  const ymd = (e: { date: Date } | null) => (e ? e.date.toISOString().slice(0, 10) : null);

  describe('the chrono-covered languages are untouched', () => {
    const cases: Array<[string, string, string | null]> = [
      ['went to the support group yesterday', 'en', '2023-05-07'],
      ['ходил в группу вчера', 'ru', '2023-05-07'],
      ['signed up 3 weeks ago', 'en', '2023-04-17'],
      ['practicing art since 2016', 'en', '2016-01-01'],
      ['I ran 2000 meters', 'en', null],
    ];
    it.each(cases)('%s (%s)', (clause, lang, expected) => {
      expect(ymd(resolveEventTime(clause, ref, { lang }))).toBe(expected);
    });
  });

  describe('Korean relative expressions', () => {
    const t = (clause: string) => ymd(resolveEventTime(clause, ref, { lang: 'ko' }));
    it('어제 → minus one day', () => expect(t('어제 병원에 갔다')).toBe('2023-05-07'));
    it('그저께 → minus two days', () => expect(t('그저께 갔었어')).toBe('2023-05-06'));
    it('3일 전 → minus three days', () => expect(t('3일 전에 만났다')).toBe('2023-05-05'));
    it('지난주 → minus one week', () => expect(t('지난주에 시작했다')).toBe('2023-05-01'));
    it('작년 → prior year', () =>
      expect(resolveEventTime('작년에 이사했다', ref, { lang: 'ko' })?.date.getUTCFullYear()).toBe(
        2022,
      ));
    it('5년 전 → five years back', () =>
      expect(
        resolveEventTime('5년 전에 졸업했다', ref, { lang: 'ko' })?.date.getUTCFullYear(),
      ).toBe(2018));
  });

  describe('Hindi relative expressions', () => {
    const t = (clause: string) => ymd(resolveEventTime(clause, ref, { lang: 'hi' }));
    it('कल → minus one day', () => expect(t('मैं कल गया था')).toBe('2023-05-07'));
    it('5 दिन पहले → minus five days', () => expect(t('5 दिन पहले हुआ')).toBe('2023-05-03'));
    it('पिछले साल → prior year', () =>
      expect(
        resolveEventTime('पिछले साल शुरू किया', ref, { lang: 'hi' })?.date.getUTCFullYear(),
      ).toBe(2022));
    it('does not match कल inside कलम (script boundary guard)', () =>
      expect(t('मैंने कलम खरीदी')).toBeNull());
  });

  describe('Arabic relative expressions + native digits', () => {
    const t = (clause: string) => ymd(resolveEventTime(clause, ref, { lang: 'ar' }));
    it('أمس → minus one day', () => expect(t('ذهبت أمس')).toBe('2023-05-07'));
    it('منذ ٣ أيام (Arabic-Indic digits) → minus three days', () =>
      expect(t('حدث منذ ٣ أيام')).toBe('2023-05-05'));
    it('قبل 3 أسابيع → minus three weeks', () => expect(t('قبل 3 أسابيع')).toBe('2023-04-17'));
    it('العام الماضي → prior year', () =>
      expect(
        resolveEventTime('العام الماضي انتقلت', ref, { lang: 'ar' })?.date.getUTCFullYear(),
      ).toBe(2022));
  });

  /**
   * The failure the Tier-0 matrix caught on 2026-09-14: an explicit
   * calendar date in a script chrono cannot read resolved to the day the
   * sentence was SAID, six months off the day it named, and did so
   * silently — the caller treats "no event time" as "use the message
   * time", so a miss is indistinguishable from an answer.
   */
  describe('explicit calendar dates chrono has no parser for', () => {
    const t = (clause: string, lang: string) => ymd(resolveEventTime(clause, ref, { lang }));
    it('Arabic, Arabic-Indic digits', () =>
      expect(t('من المقرر إطلاق التجربة في ٣ مارس ٢٠٢٢.', 'ar')).toBe('2022-03-03'));
    it('Hindi, Devanagari month name', () =>
      expect(t('पायलट लॉन्च 3 मार्च 2022 को निर्धारित है।', 'hi')).toBe('2022-03-03'));
    it('Hebrew, with the proclitic ב glued to the month', () =>
      expect(t('3 במרץ 2022', 'he')).toBe('2022-03-03'));
    it('Thai', () => expect(t('3 มีนาคม 2022', 'th')).toBe('2022-03-03'));
    it('Turkish', () => expect(t('3 Mart 2022', 'tr')).toBe('2022-03-03'));
    it('Persian, extended Arabic-Indic digits', () =>
      expect(t('۳ مارس ۲۰۲۲', 'fa')).toBe('2022-03-03'));

    it('does not fire on a month word with no day and year', () =>
      expect(t('مارس', 'ar')).toBeNull());
    it('a future date is still refused (past-only semantics)', () =>
      expect(t('٣ مارس ٢٠٩٩', 'ar')).toBeNull());
  });

  describe('day-shift fix (atUtcMidnight → speaker local calendar day)', () => {
    // 2023-05-07T15:30Z is 2023-05-08 00:30 in Tokyo — the speaker's local
    // "today" is the 8th, so "yesterday" is the 7th, NOT the UTC-day 6th.
    const boundary = '2023-05-07T15:30:00Z';
    const ko = (clause: string, o: { timeZone?: string }) =>
      ymd(resolveEventTime(clause, boundary, { lang: 'ko', ...o }));

    it('without a timezone: anchors to the UTC day (어제 → 05-06)', () => {
      expect(ko('어제', {})).toBe('2023-05-06');
    });
    it('with the session timezone: anchors to the local day (어제 → 05-07)', () => {
      expect(ko('어제', { timeZone: 'Asia/Tokyo' })).toBe('2023-05-07');
    });
    it('English "yesterday" is day-shift-corrected under a timezone too', () => {
      expect(
        ymd(
          resolveEventTime('went there yesterday', boundary, {
            lang: 'en',
            timeZone: 'Asia/Tokyo',
          }),
        ),
      ).toBe('2023-05-07');
    });
    it('an unknown timezone degrades to UTC-day behavior (never throws)', () => {
      expect(ko('어제', { timeZone: 'Not/AZone' })).toBe('2023-05-06');
    });
  });

  describe('past-only + lookback still enforced', () => {
    it('clamps an absurd lookback (30년 전) to null', () => {
      expect(resolveEventTime('30년 전', ref, { lang: 'ko' })).toBeNull();
    });
    it('a stative Korean clause with no temporal expression → null', () => {
      expect(resolveEventTime('나는 개발자입니다', ref, { lang: 'ko' })).toBeNull();
    });
  });
});
