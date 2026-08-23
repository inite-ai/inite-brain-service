/**
 * Char-span anchoring for derived-fact provenance (G3,
 * docs/roadmap/sota-gap-build-2026-08.md). W3C Web Annotation shape:
 * TextPositionSelector (start/end) + TextQuoteSelector (exact +
 * prefix/suffix context) per grounding turn.
 *
 * The deriver LLM cannot emit reliable offsets, so it emits verbatim
 * QUOTES and this module verifies them mechanically: NFC-normalize both
 * sides, find the quote as a substring, and compute offsets in Unicode
 * CODE POINTS over the NFC-normalized text (never UTF-16 units — an
 * astral char like 𝄞 counts as ONE position; the unit is documented on
 * the wire contract).
 *
 * INVARIANT — spans are computed against the STORED episode text.
 * captureTurn (episode-store.service.ts) runs redactPiiWithReport
 * BEFORE storage, and the window deriver builds its transcript from the
 * same stored rows (EpisodeReadStoreService.conversationTurns), so the
 * text the deriver quoted, the text anchored here, and the text the
 * provenance API returns are one and the same. Anchoring against any
 * pre-redaction wire text would silently shift every offset.
 *
 * Fail-safe by design: a quote that does not verify (absent, or found
 * 2+ times so the context cannot disambiguate — v1 takes none) yields
 * NO span; the fact itself always lands. Spans are optional enrichment.
 */

/** ~32 code points of surrounding context, the Hypothesis/W3C idiom. */
const CONTEXT_CODE_POINTS = 32;

/** One anchored quote inside one grounding turn's stored text. */
export interface AnchoredSpan {
  /** Inclusive start, in code points over the NFC-normalized text. */
  start: number;
  /** Exclusive end, in code points over the NFC-normalized text. */
  end: number;
  /** The verified verbatim quote (NFC, trimmed). */
  exact: string;
  /** Up to 32 code points of turn text before the quote ('' at BOF). */
  prefix: string;
  /** Up to 32 code points of turn text after the quote ('' at EOF). */
  suffix: string;
}

/** AnchoredSpan tied to its grounding episode (stored on source.charSpans). */
export interface CharSpan extends AnchoredSpan {
  episodeId: string;
}

/**
 * Verify one quote against one turn's stored text. Returns the span, or
 * null when the quote is empty, absent from the text, or ambiguous
 * (2+ occurrences — v1 drops rather than guessing; a wrong highlight is
 * worse than none).
 */
export function anchorQuote(text: string, quote: string): AnchoredSpan | null {
  const nfcText = text.normalize('NFC');
  const exact = quote.normalize('NFC').trim();
  if (exact.length === 0) return null;
  const at = nfcText.indexOf(exact);
  if (at === -1) return null;
  // Ambiguity check covers overlapping occurrences too (search from at+1).
  if (nfcText.indexOf(exact, at + 1) !== -1) return null;
  // UTF-16 index → code-point index: count code points before the match.
  const start = [...nfcText.slice(0, at)].length;
  const end = start + [...exact].length;
  const codePoints = [...nfcText];
  return {
    start,
    end,
    exact,
    prefix: codePoints.slice(Math.max(0, start - CONTEXT_CODE_POINTS), start).join(''),
    suffix: codePoints.slice(end, end + CONTEXT_CODE_POINTS).join(''),
  };
}

/**
 * Anchor a proposition's quotes against its grounding turns. `quotes`
 * is parallel to `turns` (the deriver contract); a null/absent quote,
 * an out-of-range turn index, or a quote that fails verification each
 * simply contribute no span.
 */
export function computeCharSpans(args: {
  quotes: ReadonlyArray<string | null | undefined>;
  turns: ReadonlyArray<number>;
  session: ReadonlyArray<{ id: unknown; text: string }>;
}): CharSpan[] {
  const spans: CharSpan[] = [];
  args.turns.forEach((turn, i) => {
    const quote = args.quotes[i];
    if (typeof quote !== 'string') return;
    if (!Number.isInteger(turn) || turn < 0 || turn >= args.session.length) {
      return;
    }
    const anchored = anchorQuote(args.session[turn].text, quote);
    if (anchored) {
      spans.push({ episodeId: String(args.session[turn].id), ...anchored });
    }
  });
  return spans;
}
