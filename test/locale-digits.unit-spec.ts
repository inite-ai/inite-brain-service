import { normalizeDigits } from '../src/common/locale-digits';

// `hasNonAsciiDigits` is module-private; its contract is observable through
// normalizeDigits' early-out, which returns the very same string when no
// supported digit is present.
describe('normalizeDigits', () => {
  it.each([
    ['٣ أيام', '3 أيام'], // Arabic-Indic
    ['۵', '5'], // Extended Arabic-Indic (Persian / Urdu)
    ['५ दिन', '5 दिन'], // Devanagari
    ['٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['۰۱۲۳۴۵۶۷۸۹', '0123456789'],
    ['०१२३४५६७८९', '0123456789'],
  ])('maps %p to %p', (input, expected) => {
    expect(normalizeDigits(input)).toBe(expected);
  });

  it('leaves every other character in place on mixed input', () => {
    expect(normalizeDigits('abc ٤2')).toBe('abc 42');
    expect(normalizeDigits('x۱y५z')).toBe('x1y5z');
  });

  it.each(['2024-06-01', '', 'no digits here'])('returns ASCII-only %p unchanged', (input) => {
    expect(normalizeDigits(input)).toBe(input);
  });

  it('leaves digits from unsupported scripts (Bengali) untouched', () => {
    const bengali = '৩ দিন';
    expect(normalizeDigits(bengali)).toBe(bengali);
  });
});
