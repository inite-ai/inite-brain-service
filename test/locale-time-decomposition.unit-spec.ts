import { resolveEventTime } from '../src/ingest/event-time';

/**
 * Multilingual Tier 4 — locale-time decomposition (MULTILINGUAL_TEMPORAL).
 * Three separable concerns behind opts.localeTime: (1) ar/hi/ko relative-
 * expression recognition (chrono has no parser for them), (2) native-digit
 * parsing, and (3) the atUtcMidnight day-shift fix via a session timezone.
 * Off (no opts / localeTime:false) MUST be byte-identical to the legacy path.
 *
 * Anchors use a fixed instant; the ar/hi/ko + day-shift assertions resolve
 * against the pure local-calendar-day anchor (Intl-based, host-timezone
 * independent), so they hold on any CI machine.
 */
describe('locale-time decomposition', () => {
  const ref = '2023-05-08T13:56:00Z'; // Monday, midday UTC
  const ymd = (e: { date: Date } | null) => (e ? e.date.toISOString().slice(0, 10) : null);

  describe('byte-identical when off (no opts ≡ localeTime:false)', () => {
    const cases: Array<[string, string]> = [
      ['went to the support group yesterday', 'en'],
      ['ходил в группу вчера', 'ru'],
      ['signed up 3 weeks ago', 'en'],
      ['practicing art since 2016', 'en'],
      ['I ran 2000 meters', 'en'],
    ];
    it.each(cases)('%s (%s) resolves identically with localeTime:false', (clause, lang) => {
      const legacy = resolveEventTime(clause, ref, { lang });
      const off = resolveEventTime(clause, ref, { lang, localeTime: false });
      expect(ymd(off)).toEqual(ymd(legacy));
    });
    it('a Korean clause silently misses when off (the gap Tier 4 closes)', () => {
      // chrono has no ko parser → English fallback → no date.
      expect(resolveEventTime('어제 병원에 갔다', ref, { lang: 'ko' })).toBeNull();
    });
  });

  describe('Korean relative expressions (localeTime on)', () => {
    const t = (clause: string) =>
      ymd(resolveEventTime(clause, ref, { lang: 'ko', localeTime: true }));
    it('어제 → minus one day', () => expect(t('어제 병원에 갔다')).toBe('2023-05-07'));
    it('그저께 → minus two days', () => expect(t('그저께 갔었어')).toBe('2023-05-06'));
    it('3일 전 → minus three days', () => expect(t('3일 전에 만났다')).toBe('2023-05-05'));
    it('지난주 → minus one week', () => expect(t('지난주에 시작했다')).toBe('2023-05-01'));
    it('작년 → prior year', () =>
      expect(
        resolveEventTime('작년에 이사했다', ref, {
          lang: 'ko',
          localeTime: true,
        })?.date.getUTCFullYear(),
      ).toBe(2022));
    it('5년 전 → five years back', () =>
      expect(
        resolveEventTime('5년 전에 졸업했다', ref, {
          lang: 'ko',
          localeTime: true,
        })?.date.getUTCFullYear(),
      ).toBe(2018));
  });

  describe('Hindi relative expressions (localeTime on)', () => {
    const t = (clause: string) =>
      ymd(resolveEventTime(clause, ref, { lang: 'hi', localeTime: true }));
    it('कल → minus one day', () => expect(t('मैं कल गया था')).toBe('2023-05-07'));
    it('5 दिन पहले → minus five days', () => expect(t('5 दिन पहले हुआ')).toBe('2023-05-03'));
    it('पिछले साल → prior year', () =>
      expect(
        resolveEventTime('पिछले साल शुरू किया', ref, {
          lang: 'hi',
          localeTime: true,
        })?.date.getUTCFullYear(),
      ).toBe(2022));
    it('does not match कल inside कलम (script boundary guard)', () =>
      expect(t('मैंने कलम खरीदी')).toBeNull());
  });

  describe('Arabic relative expressions + native digits (localeTime on)', () => {
    const t = (clause: string) =>
      ymd(resolveEventTime(clause, ref, { lang: 'ar', localeTime: true }));
    it('أمس → minus one day', () => expect(t('ذهبت أمس')).toBe('2023-05-07'));
    it('منذ ٣ أيام (Arabic-Indic digits) → minus three days', () =>
      expect(t('حدث منذ ٣ أيام')).toBe('2023-05-05'));
    it('قبل 3 أسابيع → minus three weeks', () => expect(t('قبل 3 أسابيع')).toBe('2023-04-17'));
    it('العام الماضي → prior year', () =>
      expect(
        resolveEventTime('العام الماضي انتقلت', ref, {
          lang: 'ar',
          localeTime: true,
        })?.date.getUTCFullYear(),
      ).toBe(2022));
  });

  describe('day-shift fix (atUtcMidnight → speaker local calendar day)', () => {
    // 2023-05-07T15:30Z is 2023-05-08 00:30 in Tokyo — the speaker's local
    // "today" is the 8th, so "yesterday" is the 7th, NOT the UTC-day 6th.
    const boundary = '2023-05-07T15:30:00Z';
    const ko = (clause: string, o: { timeZone?: string }) =>
      ymd(resolveEventTime(clause, boundary, { lang: 'ko', localeTime: true, ...o }));

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
            localeTime: true,
            timeZone: 'Asia/Tokyo',
          }),
        ),
      ).toBe('2023-05-07');
    });
    it('an unknown timezone degrades to UTC-day behavior (never throws)', () => {
      expect(ko('어제', { timeZone: 'Not/AZone' })).toBe('2023-05-06');
    });
  });

  describe('past-only + lookback still enforced under localeTime', () => {
    it('clamps an absurd lookback (30년 전) to null', () => {
      expect(resolveEventTime('30년 전', ref, { lang: 'ko', localeTime: true })).toBeNull();
    });
    it('a stative Korean clause with no temporal expression → null', () => {
      expect(
        resolveEventTime('나는 개발자입니다', ref, { lang: 'ko', localeTime: true }),
      ).toBeNull();
    });
  });
});
