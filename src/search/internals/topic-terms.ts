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

/**
 * Topic terms for line picking: a split on `/[^a-z0-9а-яё]+/i` (CJK / Thai /
 * other non-space-delimited scripts become separators and yield nothing).
 */
export function topicTerms(topic: string): string[] {
  return [
    ...new Set(
      (topic ?? '')
        .toLowerCase()
        .split(/[^a-z0-9а-яё]+/i)
        .filter((t) => t.length >= 3 && !TERM_STOP.has(t)),
    ),
  ];
}
