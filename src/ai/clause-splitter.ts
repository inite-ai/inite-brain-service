/**
 * Rule-based local clause splitter — multilingual sentence boundary
 * + coordinating-conjunction split. Pure function, no DI, sub-ms.
 *
 * Used as the foundation for the extractor hybrid pipeline (E2):
 * local NER (E3), pattern cache lookup (E6), and the skip-LLM gate
 * (E7) all operate per-clause. Embedding-based per-clause predicate
 * selection (E4) currently operates on the LLM-emitted clauses[]
 * field; once the skip gate fires it will fall back to clauses
 * derived from this splitter.
 *
 * Two-pass:
 *   1. Sentence boundary — split on `.!?…` followed by whitespace
 *      and a capital letter (Latin or Cyrillic). Preserves the
 *      terminator on the leading sentence.
 *   2. Coordinating conjunction inside each sentence — split on
 *      " and ", " but ", " or ", " и ", " но ", " или ", " а ", and
 *      "; ". The conjunction itself is dropped; trim trailing
 *      whitespace/punctuation.
 *
 * Trade-offs:
 *   • "ham and eggs" inside a noun phrase would incorrectly split.
 *     Acceptable for the demo because the noun is captured by the
 *     LLM-emitted valueSpan; the local clauses are observability +
 *     scaffolding, not ground truth.
 *   • Russian-specific sentence terminators that share Western
 *     punctuation are covered. Dedicated Cyrillic ellipsis "…" yes,
 *     anonymous "..." yes.
 *
 * No hardcoded phrase lists — the conjunction set is the closed
 * grammatical lexicon of coordinating conjunctions in each language,
 * same category as the chat router's interrogative `?`.
 */

const SENTENCE_BOUNDARY_RE = /([.!?…]+)\s+(?=[A-ZА-ЯЁ])/g;
const CONJUNCTION_RE = /\s+(?:and|but|or|и|но|или|а)\s+/i;
const SEMICOLON_SPLIT_RE = /\s*;\s+/;

export interface ClauseSplit {
  text: string;
  /** Inclusive offset into the original input message. */
  start: number;
  /** Exclusive offset. */
  end: number;
}

export function splitClauses(text: string): ClauseSplit[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Step 1: sentence boundaries. Replace terminator+ws+capital with a
  // sentinel, split on it. Reconstruct offsets by tracking cursor in
  // the ORIGINAL text.
  const SENTINEL = '\x01';
  const marked = text.replace(SENTENCE_BOUNDARY_RE, '$1' + SENTINEL);
  const sentenceRaw = marked.split(SENTINEL);

  // Step 2: coordinating conjunction + semicolon within each sentence.
  const clauses: ClauseSplit[] = [];
  let cursor = 0;
  for (const raw of sentenceRaw) {
    if (raw.length === 0) {
      cursor += 1; // sentinel
      continue;
    }
    // Find the original-text position for this sentence by searching
    // from cursor. The sentinel-replacement preserves character
    // identity, only inserts boundary markers — so the raw sentence
    // appears verbatim from cursor in the original.
    const start = text.indexOf(raw, cursor);
    if (start < 0) {
      cursor += raw.length;
      continue;
    }
    // Split the sentence further on conjunctions/semicolons. The
    // separator itself drops from the output, but we need to track
    // offsets back into the original.
    const subClauses = splitOnInternalBoundaries(raw, start);
    for (const c of subClauses) {
      const text = c.text.trim().replace(/[\s.,;:!?…—–-]+$/u, '').trim();
      if (text.length === 0) continue;
      clauses.push({
        text,
        start: c.start + c.text.indexOf(text),
        end: c.start + c.text.indexOf(text) + text.length,
      });
    }
    cursor = start + raw.length;
  }

  return clauses;
}

function splitOnInternalBoundaries(
  sentence: string,
  baseOffset: number,
): Array<{ text: string; start: number }> {
  const parts: Array<{ text: string; start: number }> = [];
  let cursor = 0;
  while (cursor < sentence.length) {
    const conjMatch = CONJUNCTION_RE.exec(sentence.slice(cursor));
    const semiMatch = SEMICOLON_SPLIT_RE.exec(sentence.slice(cursor));
    const conjStart = conjMatch
      ? cursor + conjMatch.index
      : Number.POSITIVE_INFINITY;
    const semiStart = semiMatch
      ? cursor + semiMatch.index
      : Number.POSITIVE_INFINITY;
    const next = Math.min(conjStart, semiStart);
    if (next === Number.POSITIVE_INFINITY) {
      parts.push({
        text: sentence.slice(cursor),
        start: baseOffset + cursor,
      });
      break;
    }
    const matchLen =
      conjStart < semiStart ? conjMatch![0].length : semiMatch![0].length;
    parts.push({
      text: sentence.slice(cursor, next),
      start: baseOffset + cursor,
    });
    cursor = next + matchLen;
  }
  return parts;
}
