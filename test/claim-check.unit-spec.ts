import { claimPairs, claimStands, splitAnswer } from '../src/synthesize/claim-check';

describe('splitAnswer', () => {
  it('splits sentences and reads the handles each cites', () => {
    const s = splitAnswer(
      'Maya lives in Lisbon [f1]. She works at Acme [f2, f3]. Nothing cited here.',
    );
    expect(s.map((x) => x.handles)).toEqual([['f1'], ['f2', 'f3'], []]);
    expect(s[0]!.claim).toBe('Maya lives in Lisbon.');
    expect(s[1]!.claim).toBe('She works at Acme.');
  });

  it('a citation group the segmenter leaves on the next sentence belongs to the one before', () => {
    const s = splitAnswer('Maya moved to Porto. [f1][r2] She likes it there.');
    expect(s).toHaveLength(2);
    expect(s[0]!.handles).toEqual(['f1', 'r2']);
    expect(s[1]!.handles).toEqual([]);
  });

  it('a bracket that is not a citation stays in the claim', () => {
    const s = splitAnswer('The tier is gold [beta] [f4].');
    expect(s[0]!.handles).toEqual(['f4']);
    expect(s[0]!.claim).toBe('The tier is gold [beta].');
  });

  it('splits Russian and Portuguese prose', () => {
    expect(splitAnswer('Мария живёт в Лиссабоне [f1]. Она врач [f2].')).toHaveLength(2);
    expect(splitAnswer('A Ana mora no Porto [f1]. Ela é médica [f2].')).toHaveLength(2);
  });
});

describe('claimPairs', () => {
  const facts: Record<string, string> = {
    f1: 'Maya — lives in: Lisbon',
    f2: 'Maya — works at: Acme',
  };
  it('pairs each citing sentence with exactly the facts it cites', () => {
    const pairs = claimPairs(
      splitAnswer('Maya lives in Lisbon [f1]. She works at Acme [f1, f2].'),
      (h) => facts[h],
    );
    expect(pairs.map((p) => p.premise)).toEqual([
      'Maya — lives in: Lisbon',
      'Maya — lives in: Lisbon\nMaya — works at: Acme',
    ]);
    expect(pairs[0]!.hypothesis).toBe('Maya lives in Lisbon.');
  });

  it('drops handles that resolve to nothing, and a sentence left with none', () => {
    const pairs = claimPairs(splitAnswer('A [f99]. B [f1, f99].'), (h) => facts[h]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.premise).toBe('Maya — lives in: Lisbon');
  });
});

describe('claimStands', () => {
  it('only a contradiction is unsupported; neutral and entailment stand', () => {
    expect(claimStands('contradiction')).toBe(false);
    expect(claimStands('neutral')).toBe(true);
    expect(claimStands('entailment')).toBe(true);
    expect(claimStands(undefined)).toBe(true);
  });
});
