/**
 * Cross-space cosine must not score.
 *
 * The JS-side cosine helpers compare vectors pulled into Node — a query
 * vector against stored rows. When the bge-m3 primary is warming, the
 * query is produced by the 1536-wide OpenAI fallback while rows are
 * 1024-wide. Both helpers used to truncate to the shorter vector, which
 * returns a confident-looking score computed over the first 1024
 * dimensions of two unrelated coordinate systems — and then RANKS on it.
 *
 * `vector-math.ts` was additionally contradicting its own docstring,
 * which already promised "returns 0 … when the lengths differ".
 *
 * Two other helpers in the repo (`predictor-internals.ts`,
 * `procedural-memory.service.ts`) already fail safe on a width mismatch;
 * this pins the remaining two to the same idiom.
 */
import { cosineSimilarity } from '../src/common/vector-math';
import { cosineSimilarity as routingCosine } from '../src/indexers/routing';

const BGE_WIDTH = 1024;
const OPENAI_WIDTH = 1536;

describe.each([
  ['common/vector-math', cosineSimilarity],
  ['indexers/routing', routingCosine],
])('%s cosineSimilarity', (_name, cosine) => {
  it('scores identical same-width vectors as 1', () => {
    const v = new Array(BGE_WIDTH).fill(0.1);
    expect(cosine(v, [...v])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a cross-space pair instead of a truncated score', () => {
    const bgeRow = new Array(BGE_WIDTH).fill(0.1);
    const openaiQuery = new Array(OPENAI_WIDTH).fill(0.1);
    // Truncating to 1024 would have made these look IDENTICAL (1.0) —
    // the worst possible answer, since it ranks a cross-space row top.
    expect(cosine(bgeRow, openaiQuery)).toBe(0);
    expect(cosine(openaiQuery, bgeRow)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([], new Array(BGE_WIDTH).fill(0.1))).toBe(0);
  });

  it('returns 0 for a zero-magnitude vector', () => {
    const zero = new Array(BGE_WIDTH).fill(0);
    const v = new Array(BGE_WIDTH).fill(0.1);
    expect(cosine(zero, v)).toBe(0);
  });

  it('still discriminates within a space', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosine(a, b)).toBeCloseTo(0, 10);
    expect(cosine(a, [1, 0, 0])).toBeCloseTo(1, 10);
  });
});
