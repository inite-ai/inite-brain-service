/**
 * G3 char-span anchoring (span-anchor.ts): mechanical verification of
 * deriver quotes into W3C-style spans. Pins the load-bearing unit
 * choices — NFC normalization on both sides and CODE-POINT offsets
 * (never UTF-16 units) — plus the fail-safe drops (absent quote,
 * ambiguous quote, bad turn index).
 */
import { anchorQuote, computeCharSpans } from '../src/admin/span-anchor';

describe('anchorQuote — exact match', () => {
  const text = 'Caroline adopted a kitten named Luna last Tuesday.';

  it('finds a unique quote and returns start/end/exact', () => {
    const span = anchorQuote(text, 'kitten named Luna');
    expect(span).toEqual({
      start: 19,
      end: 36,
      exact: 'kitten named Luna',
      prefix: 'Caroline adopted a ',
      suffix: ' last Tuesday.',
    });
    // Offsets round-trip: slicing the text by the span yields `exact`.
    expect([...text].slice(span!.start, span!.end).join('')).toBe(span!.exact);
  });

  it('trims leading/trailing whitespace from the quote before matching', () => {
    const span = anchorQuote(text, '  kitten named Luna ');
    expect(span?.exact).toBe('kitten named Luna');
    expect(span?.start).toBe(19);
  });

  it('quote not present → null (fail-safe drop)', () => {
    expect(anchorQuote(text, 'a puppy named Rex')).toBeNull();
  });

  it('empty / whitespace-only quote → null', () => {
    expect(anchorQuote(text, '')).toBeNull();
    expect(anchorQuote(text, '   ')).toBeNull();
  });
});

describe('anchorQuote — NFC normalization', () => {
  const COMPOSED = 'caf\u00e9'; // é as one precomposed code point
  const DECOMPOSED = 'cafe\u0301'; // e + combining acute accent

  it('decomposed quote matches composed text, offsets over NFC', () => {
    const text = `They met at the ${COMPOSED} downtown.`;
    const span = anchorQuote(text, `${DECOMPOSED} downtown`);
    expect(span).not.toBeNull();
    // Over NFC, the é is ONE code point: "They met at the " = 16.
    expect(span!.start).toBe(16);
    expect(span!.end).toBe(29);
    expect(span!.exact).toBe(`${COMPOSED} downtown`);
  });

  it('composed quote matches decomposed text', () => {
    const text = `They met at the ${DECOMPOSED} downtown.`;
    const span = anchorQuote(text, COMPOSED);
    expect(span).not.toBeNull();
    expect(span!.start).toBe(16);
    expect(span!.end).toBe(20);
    expect(span!.exact).toBe(COMPOSED);
  });
});

describe('anchorQuote — code-point offsets (astral chars)', () => {
  it('an astral char before the quote does not shift offsets', () => {
    // U+1D11E (musical G clef) is TWO UTF-16 units but ONE code point.
    const text = '\u{1D11E} marks the spot';
    const span = anchorQuote(text, 'marks the spot');
    // UTF-16 indexOf would say 3; code points say 2.
    expect(span!.start).toBe(2);
    expect(span!.end).toBe(16);
    expect([...text].slice(span!.start, span!.end).join('')).toBe('marks the spot');
  });

  it('a quote containing astral chars counts them as one position each', () => {
    const text = 'she sent \u{1F382}\u{1F389} twice';
    const span = anchorQuote(text, '\u{1F382}\u{1F389}');
    expect(span!.start).toBe(9);
    expect(span!.end).toBe(11);
  });
});

describe('anchorQuote — ambiguity (v1: 2+ occurrences → none)', () => {
  it('a quote occurring twice yields no span', () => {
    expect(anchorQuote('yes we can, yes we can', 'yes we can')).toBeNull();
  });

  it('overlapping occurrences also count as ambiguous', () => {
    expect(anchorQuote('aaaa', 'aa')).toBeNull();
  });

  it('a unique quote in repetitive text still anchors', () => {
    const span = anchorQuote('yes we can, yes we will', 'yes we will');
    expect(span?.start).toBe(12);
  });
});

describe('anchorQuote — prefix/suffix context', () => {
  it('quote at the very start → empty prefix', () => {
    const span = anchorQuote('Luna is a kitten.', 'Luna');
    expect(span?.prefix).toBe('');
    expect(span?.suffix).toBe(' is a kitten.');
  });

  it('quote at the very end → empty suffix', () => {
    const span = anchorQuote('The kitten is Luna', 'Luna');
    expect(span?.suffix).toBe('');
  });

  it('context is capped at 32 code points each side', () => {
    const text = `${'a'.repeat(50)} QUOTE ${'b'.repeat(50)}`;
    const span = anchorQuote(text, 'QUOTE');
    expect(span?.prefix).toBe(`${'a'.repeat(31)} `);
    expect(span?.suffix).toBe(` ${'b'.repeat(31)}`);
    expect([...span!.prefix].length).toBe(32);
    expect([...span!.suffix].length).toBe(32);
  });
});

describe('computeCharSpans — quotes parallel to turns', () => {
  const session = [
    { id: 'episode:e0', text: 'I adopted a kitten named Luna.' },
    { id: 'episode:e1', text: 'She loves hiking in the mountains.' },
  ];

  it('anchors each verifying quote to its turn and stamps episodeId', () => {
    const spans = computeCharSpans({
      quotes: ['kitten named Luna', 'hiking in the mountains'],
      turns: [0, 1],
      session,
    });
    expect(spans).toHaveLength(2);
    expect(spans[0]!.episodeId).toBe('episode:e0');
    expect(spans[0]!.exact).toBe('kitten named Luna');
    expect(spans[1]!.episodeId).toBe('episode:e1');
  });

  it('null quotes, failing quotes and bad turn indices contribute no span', () => {
    const spans = computeCharSpans({
      quotes: [null, 'not in the text', 'kitten named Luna', 'hiking'],
      turns: [0, 1, 7, -1],
      session,
    });
    expect(spans).toEqual([]);
  });

  it('a shorter quotes array than turns is tolerated (missing = none)', () => {
    const spans = computeCharSpans({
      quotes: ['kitten named Luna'],
      turns: [0, 1],
      session,
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.episodeId).toBe('episode:e0');
  });
});
