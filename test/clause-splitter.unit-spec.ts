/**
 * Unit-test for splitClauses — rule-based sentence + conjunction split,
 * with offsets back into the original input.
 */
import { splitClauses } from '../src/ai/clause-splitter';

const text = (s: string) => s.trim();

describe('splitClauses', () => {
  it('empty input → []', () => {
    expect(splitClauses('')).toEqual([]);
    expect(splitClauses('   ')).toEqual([]);
  });

  it('single sentence, no conjunction → 1 clause', () => {
    const out = splitClauses('Maria is the CTO at Acme.');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Maria is the CTO at Acme');
  });

  it('two sentences → 2 clauses', () => {
    const out = splitClauses('Maria is CTO. She lives in Berlin.');
    expect(out.map((c) => c.text)).toEqual([
      'Maria is CTO',
      'She lives in Berlin',
    ]);
  });

  it('sentence with coordinating conjunction → 2 clauses', () => {
    const out = splitClauses(
      'She moved from Berlin and prefers vegan lunch.',
    );
    expect(out.map((c) => c.text)).toEqual([
      'She moved from Berlin',
      'prefers vegan lunch',
    ]);
  });

  it('demo recipe — combined sentences + conjunction', () => {
    const out = splitClauses(
      'Maria Petrov is our new CTO at Acme. She moved from Berlin and prefers vegan lunch.',
    );
    expect(out.map((c) => c.text)).toEqual([
      'Maria Petrov is our new CTO at Acme',
      'She moved from Berlin',
      'prefers vegan lunch',
    ]);
  });

  it('Russian text — multilingual', () => {
    const out = splitClauses(
      'Мария новый CTO в Acme. Она переехала из Берлина и предпочитает веганский обед.',
    );
    expect(out.map((c) => c.text)).toEqual([
      'Мария новый CTO в Acme',
      'Она переехала из Берлина',
      'предпочитает веганский обед',
    ]);
  });

  it('semicolon separates clauses within sentence', () => {
    const out = splitClauses('Maria is CTO; she joined yesterday.');
    expect(out.map((c) => c.text)).toEqual([
      'Maria is CTO',
      'she joined yesterday',
    ]);
  });

  it('returns offsets that point at the original message slice', () => {
    const src = 'Maria is CTO. She lives in Berlin.';
    const out = splitClauses(src);
    expect(src.slice(out[0].start, out[0].end)).toBe('Maria is CTO');
    expect(src.slice(out[1].start, out[1].end)).toBe('She lives in Berlin');
  });

  it('does not split on lowercase after period (URLs / abbreviations OK)', () => {
    // No capital after the period → keeps it as one clause. Imperfect,
    // matches the documented trade-off.
    const out = splitClauses('See https://example.com.');
    expect(out).toHaveLength(1);
  });

  it('handles trailing punctuation in last clause', () => {
    const out = splitClauses(
      'She moved from Berlin and prefers vegan lunch!!',
    );
    expect(out[1].text).toBe('prefers vegan lunch');
  });

  it('preserves multiple inner conjunctions', () => {
    const out = splitClauses('A and B and C.');
    expect(out.map((c) => c.text)).toEqual(['A', 'B', 'C']);
  });
});
