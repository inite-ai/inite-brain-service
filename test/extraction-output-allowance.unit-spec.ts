import { extractionOutputAllowance } from '../src/ai/extractor-llm.service';

/**
 * The extraction's output copies its clauses from the input: its
 * allowance grows with the input. A fixed 1500-token allowance truncated
 * every dense document of a few kilobytes mid-JSON (measured: 150 PR
 * descriptions, responses cut at ~24 000 characters) — all samples
 * unparseable, the document read as holding nothing.
 */
describe('extractionOutputAllowance', () => {
  it('keeps a short turn at the old allowance', () => {
    expect(extractionOutputAllowance(200)).toBe(1500);
  });

  it('grows with the input: a 12 000-character chunk may answer ~24 000 characters', () => {
    // ~4 characters per token: 6000 visible tokens ≈ 24 000 characters.
    expect(extractionOutputAllowance(12_000)).toBe(6000);
  });

  it('is bounded for a pathological input', () => {
    expect(extractionOutputAllowance(1_000_000)).toBe(16_000);
  });
});
