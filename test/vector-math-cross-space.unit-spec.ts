/**
 * Cross-space cosine must not score.
 *
 * The JS-side cosine helper compares vectors pulled into Node — a query
 * vector against stored rows. When the bge-m3 primary is warming, the
 * query is produced by the 1536-wide OpenAI fallback while rows are
 * 1024-wide. Truncating to the shorter vector returns a
 * confident-looking score computed over the first 1024 dimensions of two
 * unrelated coordinate systems — and then RANKS on it.
 *
 * This file used to run the same suite twice, over two copies of the
 * function, because there were FOUR in the repo (`common/vector-math`,
 * `indexers/routing`, `ingest/predictor-internals`,
 * `procedural-memory.service`) and they had drifted apart on exactly
 * this property. There is now one, so the suite runs once — the copies
 * were the reason the test needed a loop, not a property of the maths.
 */
import { cosineSimilarity, vectorNorm } from '../src/common/vector-math';

const BGE_WIDTH = 1024;
const OPENAI_WIDTH = 1536;

describe('cosineSimilarity', () => {
  it('scores identical same-width vectors as 1', () => {
    const v = new Array(BGE_WIDTH).fill(0.1);
    expect(cosineSimilarity(v, [...v])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a cross-space pair instead of a truncated score', () => {
    const bgeRow = new Array(BGE_WIDTH).fill(0.1);
    const openaiQuery = new Array(OPENAI_WIDTH).fill(0.1);
    // Truncating to 1024 would have made these look IDENTICAL (1.0) —
    // the worst possible answer, since it ranks a cross-space row top.
    expect(cosineSimilarity(bgeRow, openaiQuery)).toBe(0);
    expect(cosineSimilarity(openaiQuery, bgeRow)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([], new Array(BGE_WIDTH).fill(0.1))).toBe(0);
  });

  it('returns 0 for a zero-magnitude vector', () => {
    const zero = new Array(BGE_WIDTH).fill(0);
    const v = new Array(BGE_WIDTH).fill(0.1);
    expect(cosineSimilarity(zero, v)).toBe(0);
  });

  it('still discriminates within a space', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
    expect(cosineSimilarity(a, [1, 0, 0])).toBeCloseTo(1, 10);
  });
});

/**
 * The precomputed-norm argument is the ONLY thing the second copy had
 * that the first did not — `predictor-internals` hoisted ‖a‖ out of a
 * scoring loop. It must be an optimization, never a different answer.
 */
describe('cosineSimilarity — precomputed aNorm', () => {
  const a = [0.3, -0.1, 0.9, 0.2];
  const b = [0.5, 0.4, -0.2, 0.7];

  it('agrees with the computed-norm form', () => {
    expect(cosineSimilarity(a, b, vectorNorm(a))).toBeCloseTo(cosineSimilarity(a, b), 12);
  });

  it('keeps every fail-safe the no-norm form has', () => {
    expect(cosineSimilarity(a, [1, 2], vectorNorm(a))).toBe(0);
    expect(cosineSimilarity([], [], 0)).toBe(0);
    expect(cosineSimilarity(a, [0, 0, 0, 0], vectorNorm(a))).toBe(0);
  });

  it('a zero norm scores 0 rather than dividing by it', () => {
    const zero = [0, 0, 0, 0];
    expect(cosineSimilarity(zero, b, vectorNorm(zero))).toBe(0);
  });
});
