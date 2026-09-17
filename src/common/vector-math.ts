/**
 * Cosine similarity over equal-length numeric vectors. THE one copy —
 * there were four (here, `indexers/routing.ts`,
 * `ingest/predictor-internals.ts`, `procedural-memory.service.ts`), and
 * the cost of that showed up as a test whose only job was to check the
 * copies agreed on a safety property. Three of them drifted apart on
 * exactly that property before it was written.
 *
 * Returns 0 when either vector has zero magnitude OR the lengths differ.
 *
 * The length check is load-bearing, not defensive tidiness. This helper
 * compares vectors that may come from different embedding spaces — a
 * 1024-wide bge-m3 row against a 1536-wide OpenAI query produced during
 * the warmup-window failover. Truncating to the shorter (which is what
 * this function used to do, contradicting the contract stated right here
 * in its own docstring) yields a confident-looking score computed over
 * the first 1024 dimensions of two unrelated coordinate systems. That is
 * numerically meaningless and, worse, silent: it ranks. Returning 0
 * makes a cross-space pair simply not match.
 *
 * `aNorm` is the caller's precomputed ‖a‖ — the one reason a second copy
 * existed. Pass it when scoring ONE query vector against many rows, so
 * the query's norm is computed once instead of per row; omit it and it
 * is computed here. Same result either way.
 */
export function cosineSimilarity(a: number[], b: number[], aNorm?: number): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  if (aNorm !== undefined && aNorm === 0) return 0;
  const len = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    // i < len = min(a.length, b.length) ⇒ both indices are in-bounds.
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    if (aNorm === undefined) na += ai * ai;
    nb += bi * bi;
  }
  const denom = (aNorm ?? Math.sqrt(na)) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** ‖v‖ — hoist this out of a scoring loop and pass it as `aNorm`. */
export function vectorNorm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}
