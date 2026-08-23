/**
 * Document chunker — split normalized text into extractor-sized windows.
 *
 * Every chunk is ≤ LLM_INPUT_LIMITS.mentionText (16 000 chars) so it flows
 * through the existing ExtractorService clamp untouched; the target is
 * lower (12 000) to leave headroom for boundary snapping. Cuts prefer a
 * paragraph boundary ('\n\n'), then a sentence/line boundary, then a hard
 * cut. Consecutive chunks overlap by ~OVERLAP chars so a fact straddling
 * a cut is fully visible in at least one chunk; the Brain's cross-chunk
 * merge collapses the resulting duplicates.
 *
 * charStart/charEnd are DOCUMENT coordinates over the normalized text —
 * candidate spans map back to the document, not just the chunk.
 *
 * Pure module — unit-testable without a DB.
 */
import { LLM_INPUT_LIMITS } from '../common/input-limits';

export interface DocumentChunk {
  seq: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Preferred chunk size; boundary snapping searches below this. */
  targetChars?: number;
  /** Hard ceiling per chunk — never exceeded. */
  maxChars?: number;
  /** Tail of each chunk repeated at the head of the next. */
  overlapChars?: number;
}

const DEFAULT_TARGET = 12_000;
const DEFAULT_OVERLAP = 400;
/** Don't snap to a boundary that would leave the chunk pathologically short. */
const MIN_CUT_RATIO = 0.5;

export function chunkDocument(text: string, opts: ChunkOptions = {}): DocumentChunk[] {
  const maxChars = Math.min(
    opts.maxChars ?? LLM_INPUT_LIMITS.mentionText,
    LLM_INPUT_LIMITS.mentionText,
  );
  const targetChars = Math.min(opts.targetChars ?? DEFAULT_TARGET, maxChars);
  const overlapChars = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(targetChars / 4));

  if (text.length <= maxChars) {
    if (!text.length) return [];
    return [{ seq: 0, text, charStart: 0, charEnd: text.length }];
  }

  const chunks: DocumentChunk[] = [];
  let start = 0;
  let seq = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maxChars) {
      chunks.push({
        seq,
        text: text.slice(start),
        charStart: start,
        charEnd: text.length,
      });
      break;
    }

    const window = text.slice(start, start + targetChars);
    const minCut = Math.floor(targetChars * MIN_CUT_RATIO);
    let cut = lastBoundary(window, '\n\n', minCut);
    if (cut === -1) cut = lastBoundary(window, '\n', minCut);
    if (cut === -1) cut = lastBoundary(window, '. ', minCut);
    if (cut === -1) cut = targetChars;

    const end = start + cut;
    chunks.push({ seq, text: text.slice(start, end), charStart: start, charEnd: end });
    seq += 1;
    // Overlap: next chunk re-reads the tail of this one. Guaranteed
    // progress — overlap is capped at targetChars/4, so end - overlap >
    // start always holds for the cut ≥ minCut branches and the hard cut.
    start = end - overlapChars;
  }
  return chunks;
}

/**
 * Rightmost occurrence of `boundary` at or after `minIndex`, returned as
 * the cut position AFTER the boundary text; -1 when absent.
 */
function lastBoundary(window: string, boundary: string, minIndex: number): number {
  const at = window.lastIndexOf(boundary);
  if (at === -1 || at < minIndex) return -1;
  return at + boundary.length;
}
