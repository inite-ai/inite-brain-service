/**
 * The cross-encoder scoring loop, shared by the worker thread and the
 * in-thread path so both obey one deadline contract.
 *
 * Pairs are scored in CHUNKS — one batched forward pass per chunk — and
 * an ABSOLUTE deadline is checked between chunks against the observed
 * per-pair cost, so the loop stops BEFORE the chunk that would overshoot.
 * Whatever the deadline leaves unscored keeps -Infinity and sinks to the
 * tail; the array length always matches the input, so the caller's
 * permutation stays valid.
 *
 * WHY THIS SHAPE. The previous loop ran one forward pass per pair and
 * checked a RELATIVE deadline between pairs — the same number as the
 * caller's stage budget. On a host where a pair costs ~140 ms (a 2-vCPU
 * droplet; ~10 ms on an M-series laptop) a 20-pair window takes ~2.8 s:
 * the loop overshot its own 2 s deadline by a pair, the caller's stage
 * timer fired first, and the scores the worker had already computed were
 * dropped on the floor. Production paid the full budget on every search
 * for an identity permutation — 81 budget fallbacks in 72 hours of logs
 * and not one cross-encoder ordering served. Batching brings the per-pair
 * cost down (~110 ms on the same host) and the estimate-before-chunk
 * check keeps the partial result inside the budget instead of past it.
 */

/** The two transformers.js callables the loop needs, batch-capable. */
export interface PairScorer {
  tokenizer: (
    queries: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<unknown>;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>;
}

export interface ScorePairsRequest {
  query: string;
  documents: string[];
  /** Epoch ms after which no further chunk is started. */
  deadlineAt?: number | undefined;
  /** Pairs per forward pass. */
  chunk?: number | undefined;
}

/**
 * Four pairs per pass: on the slow host that is ~0.5 s of work, small
 * enough that the first (unestimated) chunk always fits a 2 s budget and
 * the between-chunk check has several points at which to stop.
 */
export const SCORE_CHUNK = 4;

/**
 * Relevance logit per document, in input order; -Infinity where the
 * deadline stopped the loop first. A deadline already in the past scores
 * nothing (no forward pass is started for a caller that has given up).
 */
export async function scorePairs(
  scorer: PairScorer,
  { query, documents, deadlineAt, chunk: chunkSize }: ScorePairsRequest,
): Promise<number[]> {
  const chunk = Math.max(1, chunkSize ?? SCORE_CHUNK);
  const scores: number[] = new Array(documents.length).fill(Number.NEGATIVE_INFINITY);
  // Worst observed per-pair cost so far — conservative on purpose: a
  // chunk padded to a long document costs more than the mean says.
  let perPairMs = 0;
  for (let start = 0; start < documents.length; start += chunk) {
    const docs = documents.slice(start, start + chunk);
    if (deadlineAt !== undefined) {
      const now = Date.now();
      if (now >= deadlineAt) break;
      if (perPairMs > 0 && now + perPairMs * docs.length > deadlineAt) break;
    }
    const t0 = Date.now();
    const inputs = await scorer.tokenizer(new Array<string>(docs.length).fill(query), {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const out = await scorer.model(inputs);
    const logits = out.logits.data;
    for (let i = 0; i < docs.length; i++) {
      const v = logits[i];
      if (typeof v === 'number' && Number.isFinite(v)) scores[start + i] = v;
    }
    perPairMs = Math.max(perPairMs, (Date.now() - t0) / docs.length);
  }
  return scores;
}
