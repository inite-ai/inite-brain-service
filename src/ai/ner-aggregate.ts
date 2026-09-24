/**
 * Span aggregation for transformers.js token classification.
 *
 * transformers.js 2.x returns one row PER WORDPIECE TOKEN and ignores
 * `aggregation_strategy` (a python-only option): "Helio Robotics"
 * arrives as `He` B-ORG, `##lio` I-ORG, `Robot` I-ORG, `##ics` I-ORG,
 * and a CJK name arrives one character per row because the multilingual
 * BERT tokenizer splits CJK into single characters. Consumed raw, every
 * row became an entity — 12 junk rows per four turns on the prod tenant
 * (`He`, `##lio`, `##ics`, `Robot`, 夫, 索, 姆 …). This is the merge the
 * pipeline never did: IOB runs become one span, subwords glue to their
 * word, and the span text is cut from the ORIGINAL text, so spacing and
 * the middle dot in 阿尔乔姆·索科洛夫 come back exactly as written.
 *
 * Offsets are recovered by walking the source text with a cursor —
 * the pipeline reports `start`/`end` as null on this version.
 */

/** One row as the transformers.js token-classification pipeline returns it. */
export interface NerToken {
  /** IOB tag (`B-PER`, `I-ORG`) or a bare label on models without prefixes. */
  entity: string;
  score: number;
  /** Position in the tokenised input; a gap means an `O` token was dropped. */
  index: number;
  /** Decoded wordpiece; continuation pieces start with `##`. */
  word: string;
}

export interface NerSpan {
  text: string;
  type: string;
  start: number;
  end: number;
  /** Mean token score across the span. */
  score: number;
}

const SUBWORD_PREFIX = '##';
/** Letters, marks and digits — what a span must contain to be an entity. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
/**
 * Scripts written without spaces: a token boundary there is NOT a word
 * boundary, so the word-completion step must not run over them (it would
 * swallow the rest of a Chinese sentence).
 */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function isSpacedWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch) && !UNSPACED.test(ch);
}

function parseTag(entity: string): { begins: boolean; group: string } {
  const m = /^([BIES])-(.+)$/u.exec(entity);
  if (!m) return { begins: false, group: entity };
  return { begins: m[1] === 'B' || m[1] === 'S', group: m[2]! };
}

interface OpenSpan {
  group: string;
  start: number;
  end: number;
  lastIndex: number;
  scores: number[];
}

export function aggregateNerTokens(text: string, tokens: readonly NerToken[]): NerSpan[] {
  const out: NerSpan[] = [];
  let open: OpenSpan | null = null;
  let cursor = 0;

  const close = (span: OpenSpan): void => {
    let { start, end } = span;
    // A span that starts or ends inside a spaced-script word (its other
    // pieces were tagged O) is completed to the word.
    while (start > 0 && isSpacedWordChar(text[start - 1])) start--;
    while (end < text.length && isSpacedWordChar(text[end])) end++;
    const slice = text.slice(start, end);
    if (!WORD_CHAR.test(slice)) return;
    out.push({
      text: slice,
      type: span.group.toUpperCase(),
      start,
      end,
      score: span.scores.reduce((a, b) => a + b, 0) / span.scores.length,
    });
  };

  for (const token of [...tokens].sort((a, b) => a.index - b.index)) {
    const continuation = token.word.startsWith(SUBWORD_PREFIX);
    const piece = continuation ? token.word.slice(SUBWORD_PREFIX.length) : token.word;
    if (piece === '') continue;
    const at = text.indexOf(piece, cursor);
    if (at === -1) {
      if (open) close(open);
      open = null;
      continue;
    }
    cursor = at + piece.length;
    const { begins, group } = parseTag(token.entity);
    // A subword never opens a span of its own: it belongs to the word
    // the previous piece started, whatever tag it was given.
    const joins =
      open !== null &&
      token.index === open.lastIndex + 1 &&
      (continuation || (!begins && group === open.group));
    if (open && joins) {
      open.lastIndex = token.index;
      open.scores.push(token.score);
      if (WORD_CHAR.test(piece)) open.end = cursor;
      continue;
    }
    if (open) close(open);
    // Punctuation between two runs (the · of a transliterated name)
    // may join a span but never starts one.
    open = WORD_CHAR.test(piece)
      ? { group, start: at, end: cursor, lastIndex: token.index, scores: [token.score] }
      : null;
  }
  if (open) close(open);
  return out;
}
