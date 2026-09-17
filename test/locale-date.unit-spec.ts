import { parseLocaleAbsoluteDate } from '../src/ingest/locale-date';

/**
 * The ICU-derived absolute-date reader.
 *
 * Two halves matter and both are pinned here. It has to READ a plain
 * "3 March 2026" written the way each locale writes it — which is the gap
 * that put 2026-09-14 into a fact that said 2026-03-03. And it has to
 * REFUSE everything short of a full explicit date, because it runs as a
 * fallback after chrono and a false positive invents an event that never
 * happened. The refusals are the larger half of the file on purpose.
 *
 * Nothing here asserts a month NAME: the names come from ICU, so a test
 * that spelled them out would be testing a copy of CLDR rather than the
 * code, and would rot the first time a locale's data is corrected.
 */
describe('absolute calendar dates, per locale', () => {
  const day = (clause: string, locale: string): string | null =>
    parseLocaleAbsoluteDate(clause, locale)?.date.toISOString().slice(0, 10) ?? null;

  describe('reads the date each locale actually writes', () => {
    const cases: Array<[string, string]> = [
      ['en', 'The pilot launch is scheduled for March 3, 2026.'],
      ['de', 'Der Pilotstart ist für 3. März 2026 geplant.'],
      ['es', 'El lanzamiento piloto está previsto para 3 de marzo de 2026.'],
      ['ru', 'Запуск пилота назначен на 3 марта 2026.'],
      ['ar', 'من المقرر إطلاق التجربة في ٣ مارس ٢٠٢٦.'],
      ['hi', 'पायलट लॉन्च 3 मार्च 2026 को निर्धारित है।'],
      ['th', '3 มีนาคม 2026'],
      ['tr', '3 Mart 2026'],
      ['pl', '3 marca 2026'],
      ['uk', '3 березня 2026'],
      ['cs', '3. března 2026'],
      ['id', '3 Maret 2026'],
      ['fa', '۳ مارس ۲۰۲۶'],
    ];
    it.each(cases)('%s: %s', (locale, clause) => {
      expect(day(clause, locale)).toBe('2026-03-03');
    });

    it('reads the genitive month a date carries, not the nominative', () => {
      // ICU's standalone month for ru is "март"; a date says "марта". Both
      // spellings are collected, so neither form is a miss.
      expect(day('3 марта 2026', 'ru')).toBe('2026-03-03');
      expect(day('3 март 2026', 'ru')).toBe('2026-03-03');
    });

    it('reads a month with a proclitic glued on (he: ב + מרץ)', () => {
      expect(day('3 במרץ 2026', 'he')).toBe('2026-03-03');
      expect(day('3 מרץ 2026', 'he')).toBe('2026-03-03');
    });

    it('does not care which side the day falls on', () => {
      expect(day('March 3, 2026', 'en')).toBe('2026-03-03');
      expect(day('3 March 2026', 'en')).toBe('2026-03-03');
      expect(day('2026, 3 March', 'en')).toBe('2026-03-03');
    });

    it('normalizes native digits in place', () => {
      expect(day('١٥ ديسمبر ٢٠٢٤', 'ar')).toBe('2024-12-15');
      expect(day('२५ दिसंबर २०२५', 'hi')).toBe('2025-12-25');
    });

    it('reports the span it matched', () => {
      const hit = parseLocaleAbsoluteDate('Запуск назначен на 3 марта 2026.', 'ru');
      expect(hit?.expr).toBe('3 марта 2026');
    });
  });

  describe('refuses anything short of an explicit date', () => {
    it('a month word alone is not a date', () => {
      expect(day('march to the exit', 'en')).toBeNull();
      expect(day('we may go later', 'en')).toBeNull();
      expect(day('в марте было тепло', 'ru')).toBeNull();
    });
    it('a month and a year with no day is declined, not guessed at the 1st', () => {
      expect(day('March 2026', 'en')).toBeNull();
      expect(day('مارس ٢٠٢٦', 'ar')).toBeNull();
    });
    it('a day and a year with no month name is not its business', () => {
      expect(day('3 / 3 / 2026', 'en')).toBeNull();
    });
    it('bare quantities near a month word do not become a date', () => {
      expect(day('в марте будет 2000 метров', 'ru')).toBeNull();
      expect(day('march 2000 meters', 'en')).toBeNull();
    });
    it('a day that does not exist in that month is refused, not rolled over', () => {
      expect(day('31 February 2026', 'en')).toBeNull();
      expect(day('30 February 2026', 'en')).toBeNull();
      expect(day('31 April 2026', 'en')).toBeNull();
      expect(day('29 February 2024', 'en')).toBe('2024-02-29'); // a real leap day
    });
    it('a month name inside a longer word is not a match', () => {
      expect(day('3 marches 2026', 'en')).toBeNull();
      expect(day('3 мартышка 2026', 'ru')).toBeNull();
    });
    it('declines a locale whose month names are numeric rather than guessing', () => {
      // ja "3月" / ko "3월" / vi "tháng 3" are the number beside them; a
      // lexicon cannot separate the two, and chrono covers ja/zh natively.
      expect(day('2026年3月3日', 'ja')).toBeNull();
      expect(day('2026년 3월 3일', 'ko')).toBeNull();
    });
    it('empty, missing and malformed inputs return null rather than throwing', () => {
      expect(day('', 'en')).toBeNull();
      expect(parseLocaleAbsoluteDate('3 March 2026', undefined)).toBeNull();
      expect(day('3 March 2026', 'not-a-locale-tag!!')).toBeNull();
      expect(day('no date here at all', 'en')).toBeNull();
    });
  });
});
