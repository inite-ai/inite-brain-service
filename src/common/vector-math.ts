/**
 * Cosine similarity over equal-length numeric vectors.
 *
 * Returns 0 when either vector has zero magnitude or the lengths differ.
 * Mismatched lengths use the shorter — defensive against partial reads
 * from the DB where a row may carry a truncated embedding.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
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
