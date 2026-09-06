/**
 * Transition classifier stage (EXTRACTOR_TRANSITION_CLASSIFIER, stage
 * 2 of 2). NO live BGE-M3 here: the embedder stub is a deterministic
 * bag-of-words hash embedding, so cosine genuinely reflects token
 * overlap instead of faking semantics — test inputs are chosen to
 * share tokens with the prototypes they should land on ("sold" with
 * the dispose bank, "переехали" stemming-free with the change bank's
 * "переехал" is NOT expected to match, so RU inputs reuse exact bank
 * tokens). The real embedder replaces token overlap with semantics;
 * argmax/margin/caching mechanics are what this spec pins down.
 */
import {
  TRANSITION_CLASSES,
  TRANSITION_MARGIN_DEFAULT,
  TRANSITION_PROTOTYPES,
  TRANSITION_SCORE_FLOOR,
  createTransitionClassifier,
  type EmbedFn,
} from '../src/ai/extractor-internals/transition-classifier';

/**
 * Prime, not a power of two: fnv1a's low bits are weak under mod-2^k
 * (at 512 'свою' collided with 'продать' and flipped a RU dispose case
 * to intention; 'joined'/'moved' still collided at 8192). 4093 was
 * verified collision-free over the full vocabulary of this spec's
 * prototypes + inputs, so cosine here reflects ONLY token overlap.
 */
const DIM = 4093;

/** FNV-1a over a token — deterministic, no randomness anywhere. */
function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Bag-of-words hash embedding: one bucket per hashed lowercase token. */
function bowVector(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  for (const token of tokens) vec[fnv1a(token) % DIM]! += 1;
  return vec;
}

/** Stub embedder counting invocations and recording batch payloads. */
function makeStubEmbed(): { embed: EmbedFn; calls: string[][] } {
  const calls: string[][] = [];
  const embed: EmbedFn = (texts) => {
    calls.push([...texts]);
    return Promise.resolve(texts.map(bowVector));
  };
  return { embed, calls };
}

const BANK_SIZE = TRANSITION_CLASSES.reduce((n, cls) => n + TRANSITION_PROTOTYPES[cls].length, 0);

describe('prototype bank shape', () => {
  it('every class has 6-10 prototypes', () => {
    for (const cls of TRANSITION_CLASSES) {
      expect(TRANSITION_PROTOTYPES[cls].length).toBeGreaterThanOrEqual(6);
      expect(TRANSITION_PROTOTYPES[cls].length).toBeLessThanOrEqual(10);
    }
  });

  it('every class carries BOTH English and Russian prototypes (multilingual by construction)', () => {
    for (const cls of TRANSITION_CLASSES) {
      const texts = TRANSITION_PROTOTYPES[cls];
      expect(texts.some((t) => /[а-яё]/i.test(t))).toBe(true);
      expect(texts.some((t) => /^[\x00-\x7F]+$/.test(t))).toBe(true);
    }
  });

  it('calibration constants are exported, sane placeholders', () => {
    // Values are PLACEHOLDERS pending stand calibration (see the doc
    // comments) — this only pins that they exist and are usable gates.
    expect(TRANSITION_MARGIN_DEFAULT).toBeGreaterThan(0);
    expect(TRANSITION_MARGIN_DEFAULT).toBeLessThan(1);
    expect(TRANSITION_SCORE_FLOOR).toBeGreaterThan(0);
    expect(TRANSITION_SCORE_FLOOR).toBeLessThan(1);
  });
});

describe('classify — argmax on token-overlap clear cases', () => {
  it.each([
    // input clause, expected class, load-bearing shared token(s)
    ['I sold my old car.', 'completed_dispose'], // "sold … car" ⊂ "I sold my car last week."
    ['He joined the team.', 'completed_acquire'], // "he joined the" ⊂ "He joined the chess team."
    ['We moved to Berlin last spring.', 'completed_change'], // ⊃ "We moved to Berlin."
    ['I am thinking about selling my old car.', 'intention'], // ⊃ "thinking about selling my"
    ['The office is on the second floor.', 'unrelated'], // ⊃ "the office is on the … floor"
    ['Я продал свою машину.', 'completed_dispose'], // "продал машину" ⊂ RU dispose prototype
  ] as const)('%s → %s with positive margin', async (clause, expected) => {
    const { embed } = makeStubEmbed();
    const clf = createTransitionClassifier(embed);
    const [verdict] = await clf.classify([clause]);
    expect(verdict).toBeDefined();
    expect(verdict!.cls).toBe(expected);
    expect(verdict!.score).toBeGreaterThan(0);
    expect(verdict!.margin).toBeGreaterThan(0);
  });

  it('a prototype sentence itself scores ~1.0 on its own class', async () => {
    const { embed } = makeStubEmbed();
    const clf = createTransitionClassifier(embed);
    const [verdict] = await clf.classify(['I sold my car last week.']);
    expect(verdict!.cls).toBe('completed_dispose');
    expect(verdict!.score).toBeCloseTo(1.0, 10);
  });

  it('returns one verdict per input clause, in input order', async () => {
    const { embed } = makeStubEmbed();
    const clf = createTransitionClassifier(embed);
    const verdicts = await clf.classify(['I sold my old car.', 'He joined the team.']);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.cls).toBe('completed_dispose');
    expect(verdicts[1]!.cls).toBe('completed_acquire');
  });
});

describe('classify — prototype caching and batch shape', () => {
  it('embeds the bank ONCE across two classify() calls; inputs go as one batch each', async () => {
    const { embed, calls } = makeStubEmbed();
    const clf = createTransitionClassifier(embed);

    await clf.classify(['I sold my old car.', 'He joined the team.']);
    // Call 1 = the flattened bank (class order), call 2 = the inputs.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(BANK_SIZE);
    expect(calls[0]).toEqual(TRANSITION_CLASSES.flatMap((cls) => [...TRANSITION_PROTOTYPES[cls]]));
    expect(calls[1]).toEqual(['I sold my old car.', 'He joined the team.']);

    await clf.classify(['We moved to Berlin last spring.']);
    // Bank NOT re-embedded: only one new call, carrying only the inputs.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['We moved to Berlin last spring.']);
  });

  it('classify([]) returns [] without invoking the embedder at all', async () => {
    const { embed, calls } = makeStubEmbed();
    const clf = createTransitionClassifier(embed);
    await expect(clf.classify([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a failed bank embedding is not cached — the next call retries', async () => {
    let attempts = 0;
    const flaky: EmbedFn = (texts) => {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('embedder down'));
      return Promise.resolve(texts.map(bowVector));
    };
    const clf = createTransitionClassifier(flaky);
    await expect(clf.classify(['I sold my old car.'])).rejects.toThrow('embedder down');
    const [verdict] = await clf.classify(['I sold my old car.']);
    expect(verdict!.cls).toBe('completed_dispose');
    // attempt 1 = failed bank, attempt 2 = bank retry, attempt 3 = inputs.
    expect(attempts).toBe(3);
  });
});
