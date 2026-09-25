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
 * Topic terms for line picking. Default = the byte-identical legacy split
 * on `/[^a-z0-9а-яё]+/i` (CJK / Thai / other non-space-delimited scripts
 * become separators and yield nothing).
 *
 * When `segmentCjk` is set (MULTILINGUAL_CJK_SEGMENTATION, resolved at the
 * profile boundary and threaded in — this module stays env-free), the topic
 * is segmented with the `Intl.Segmenter` built-in (ICU-backed word
 * boundaries, NO new dependency) so CJK/ideographic text yields real terms.
 * Falls back to the legacy split when the runtime lacks Intl.Segmenter.
 */
export function topicTerms(topic: string, segmentCjk = false): string[] {
  if (segmentCjk) {
    const segmented = segmentTopicTerms(topic ?? '');
    if (segmented) return segmented;
    // Runtime without Intl.Segmenter — fall through to the legacy split.
  }
  return [
    ...new Set(
      (topic ?? '')
        .toLowerCase()
        .split(/[^a-z0-9а-яё]+/i)
        .filter((t) => t.length >= 3 && !TERM_STOP.has(t)),
    ),
  ];
}

// Minimal local typing for the Intl.Segmenter built-in: `target: ES2021`
// does not pull lib.es2022.intl, and Node ≥16 ships the runtime. Declaring
// the tiny slice we use (rather than widening the tsconfig lib) keeps the
// change local and degrades gracefully when the constructor is absent.
interface WordLikeSegment {
  segment: string;
  isWordLike?: boolean;
}
interface SegmenterLike {
  segment(input: string): Iterable<WordLikeSegment>;
}
type SegmenterCtor = new (
  locales?: string | string[] | undefined,
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => SegmenterLike;

/** CJK / ideographic scripts whose words are meaningful at length 1–2, so
 *  the ASCII ≥3 glue filter must not apply to them. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * ICU word segmentation via Intl.Segmenter. Returns null when the runtime
 * has no Intl.Segmenter so the caller falls back to the legacy split.
 * Latin/Cyrillic word-like segments keep the ≥3 glue filter (parity with
 * the legacy path); CJK words are kept from length 1.
 */
function segmentTopicTerms(topic: string): string[] | null {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Segmenter) return null;
  const seg = new Segmenter(undefined, { granularity: 'word' });
  const out = new Set<string>();
  for (const piece of seg.segment(topic)) {
    if (!piece.isWordLike) continue;
    const t = piece.segment.toLowerCase();
    const minLen = CJK_RE.test(t) ? 1 : 3;
    if (t.length >= minLen && !TERM_STOP.has(t)) out.add(t);
  }
  return [...out];
}
