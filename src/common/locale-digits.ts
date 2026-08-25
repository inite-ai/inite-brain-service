/**
 * Locale digit normalization — map non-ASCII decimal digits to 0-9.
 *
 * Multilingual Tier 4 shared primitive. Arabic-Indic (٠-٩), Extended
 * Arabic-Indic / Persian-Urdu (۰-۹) and Devanagari (०-९) digits are the
 * high-value scripts for the ar / fa / ur / hi relative-time parser
 * (event-time) and the typed-value conflict comparison (answer-router):
 * a native-digit "٣ أيام" / "५ दिन" must reduce to "3" / "5" before any
 * numeric match. ASCII digits pass through untouched, so on ASCII input
 * this is a no-op (byte-identical).
 *
 * Deliberately small — only the digit ranges the Tier 4 parsers exercise.
 * Other decimal scripts (Bengali, Thai, …) can be added when a consumer
 * needs them; Intl has no built-in "digits → ASCII" so a table is the
 * dependency-free way (no new npm dep).
 */

/** [base codepoint of the '0' digit, script label] for each supported set. */
const DIGIT_BASES: ReadonlyArray<readonly [number, string]> = [
  [0x0660, 'arabic-indic'], // ٠١٢٣٤٥٦٧٨٩
  [0x06f0, 'extended-arabic-indic'], // ۰۱۲۳۴۵۶۷۸۹ (Persian / Urdu)
  [0x0966, 'devanagari'], // ०१२३४५६७८९
];

/** True when the string carries any non-ASCII decimal digit we normalize. */
export function hasNonAsciiDigits(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    for (const [base] of DIGIT_BASES) {
      if (code >= base && code <= base + 9) return true;
    }
  }
  return false;
}

/**
 * Replace every supported non-ASCII decimal digit with its ASCII 0-9
 * equivalent, position-preserving. ASCII-only input returns the same
 * characters (a cheap early-out keeps the common path allocation-free).
 */
export function normalizeDigits(text: string): string {
  if (!text || !hasNonAsciiDigits(text)) return text;
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    let mapped = ch;
    for (const [base] of DIGIT_BASES) {
      if (code >= base && code <= base + 9) {
        mapped = String.fromCharCode(0x30 + (code - base));
        break;
      }
    }
    out += mapped;
  }
  return out;
}
