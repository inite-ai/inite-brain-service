/**
 * Cosine similarity over equal-length numeric vectors.
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
 * makes a cross-space pair simply not match, matching the fail-safe
 * idiom already used by `predictor-internals.ts` and
 * `procedural-memory.service.ts`.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  const len = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    // i < len = min(a.length, b.length) ⇒ both indices are in-bounds.
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
