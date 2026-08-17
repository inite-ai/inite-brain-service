import { detectVerbatimShape } from '../search/verbatim-routing';

/**
 * V13 G2 per-shape answer conditioning (RETRIEVAL_ANSWER_CONDITIONING).
 * The discriminator (§10) put 22% of misses in the gold-in-window
 * bucket — the evidence was IN the prompt and the answer still missed;
 * per-shape reading instructions are the measured external lever for
 * that class (Penfield: +10.7pp prompt-alone). armG covered only the
 * date-instruction slice and measured null; this is the full set.
 *
 * Shapes deliberately do NOT duplicate the lane registry: lanes route
 * enumeration/temporal/summary dispatch, while these shapes condition
 * HOW the generator reads evidence for reasoning classes the lanes
 * never dispatch (why/how chains, broad aggregation, verbatim recall).
 * The block composes with the lane frame; both can render.
 */
export type AnswerShape = 'chained' | 'aggregation' | 'verbatim';

const CHAINED_RES: readonly RegExp[] = [
  /\bwhy\b/i,
  /\bhow (?:did|does|has|come)\b/i,
  /\bwhat (?:led to|caused|made)\b/i,
  /\b(?:reason|because of what)\b/i,
  /\bconnection between\b/i,
  /\bhow .{0,40}\brelated?\b/i,
];

const AGGREGATION_RES: readonly RegExp[] = [
  /\btell me (?:about|everything)\b/i,
  /\bwhat do you know about\b/i,
  /\bdescribe\b/i,
  /\boverview of\b/i,
  /\bwhat kinds? of\b/i,
  /\bwhat sorts? of\b/i,
];

/** First matching shape wins; null = no conditioning block. */
export function detectAnswerShape(query: string): AnswerShape | null {
  if (CHAINED_RES.some((re) => re.test(query))) return 'chained';
  if (AGGREGATION_RES.some((re) => re.test(query))) return 'aggregation';
  if (detectVerbatimShape(query)) return 'verbatim';
  return null;
}

const SHAPE_INSTRUCTIONS: Record<AnswerShape, string> = {
  chained:
    'Answer shape: this question needs facts CHAINED together. Identify each supporting fact first, connect them step by step, and state only the conclusion the chain supports. If one link is missing from the evidence, say what is missing instead of bridging the gap yourself.\n',
  aggregation:
    'Answer shape: this question asks for coverage. Cover every DISTINCT relevant aspect the evidence supports — one claim per aspect, organized, completeness over brevity — and do not restate one aspect in different words.\n',
  verbatim:
    'Answer shape: this question asks for a specific recorded detail. Answer with the exact wording the evidence uses — copy the specific name, number, title or phrase; do not paraphrase or generalize it.\n',
};

export function shapeInstructionFor(shape: AnswerShape): string {
  return SHAPE_INSTRUCTIONS[shape];
}
