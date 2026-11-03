/**
 * Topic terms of a query — the stripped content words a lexical matcher
 * is fed one by one (lex-leg.ts). Pure; lives in the search layer so the
 * retrieval legs and the synthesize lanes share one tokenizer.
 */
const TERM_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'about',
  'into',
  'from',
  'over',
  'have',
  'has',
  'had',
  'was',
  'were',
  'are',
  'you',
  'your',
  'our',
  // V10 §3 (R1): ask-scaffold words that survive the strip in odd
  // phrasings must never count as topic terms.
  'mention',
  'only',
  'item',
  'items',
  'order',
  'answer',
]);

/** Scripts written without spaces: a run of them is one term however short. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Topic terms for line picking: a split on anything that is not a letter,
 * a combining mark or a digit in any script (a Devanagari vowel sign or a
 * Russian stress mark is part of its word). The split was `[^a-z0-9а-яё]`, which cut
 * "contratação" into "contrata" and "o" and dropped every CJK word (#892).
 * Words under three characters carry no topic, except in the unspaced
 * scripts, where two characters are a whole word (合同).
 */
export function topicTerms(topic: string): string[] {
  return [
    ...new Set(
      (topic ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{M}\p{N}]+/u)
        .filter((t) => (t.length >= 3 || (t.length >= 2 && UNSPACED.test(t))) && !TERM_STOP.has(t)),
    ),
  ];
}
