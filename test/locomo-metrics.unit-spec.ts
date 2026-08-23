/**
 * Coverage for the LoCoMo scoring metrics.
 *
 * Pure-function tests — no I/O, no brain process. Pins paper-aligned
 * behaviour: SQuAD-style token F1, ROUGE-L over LCS, BLEU-1 with
 * brevity penalty, and the adversarial-refusal heuristic for
 * category-5 questions.
 */
import {
  tokenF1,
  exactMatch,
  rougeL,
  bleu1,
  adversarialScore,
  isRefusal,
  tokenize,
  normalize,
} from '../test/eval/locomo/metrics';

describe('LoCoMo metrics', () => {
  describe('normalize + tokenize', () => {
    it('lowercases and strips punctuation', () => {
      expect(normalize('Hello, World!')).toBe('hello world');
      expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
    });
    it('handles empty input', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize('   ')).toEqual([]);
    });
  });

  describe('tokenF1', () => {
    it('returns 1 on exact match', () => {
      expect(tokenF1('blue car', 'blue car')).toBe(1);
    });
    it('returns 1 when both are empty', () => {
      expect(tokenF1('', '')).toBe(1);
    });
    it('returns 0 when only one side is empty', () => {
      expect(tokenF1('', 'blue car')).toBe(0);
      expect(tokenF1('blue car', '')).toBe(0);
    });
    it('handles partial overlap with multiset semantics', () => {
      // pred: "blue blue car"  gold: "blue car red"
      // common = min(2,1)['blue'] + min(1,1)['car'] = 2
      // precision = 2/3, recall = 2/3, F1 = 2/3
      const f1 = tokenF1('blue blue car', 'blue car red');
      expect(f1).toBeCloseTo(2 / 3, 6);
    });
  });

  describe('exactMatch', () => {
    it('ignores casing and punctuation', () => {
      expect(exactMatch('Hello, world.', 'hello world')).toBe(1);
      expect(exactMatch('hello world!', 'goodbye world')).toBe(0);
    });
  });

  describe('rougeL', () => {
    it('returns 1 on exact match', () => {
      expect(rougeL('the quick brown fox', 'the quick brown fox')).toBe(1);
    });
    it('scores partial LCS', () => {
      // LCS('the quick brown fox', 'the brown fox jumps') = "the brown fox" → 3
      const score = rougeL('the quick brown fox', 'the brown fox jumps');
      // precision = 3/4, recall = 3/4, F1 = 0.75
      expect(score).toBeCloseTo(0.75, 6);
    });
  });

  describe('bleu1', () => {
    it('returns ~1 on identical phrasing', () => {
      expect(bleu1('the cat sat on the mat', 'the cat sat on the mat')).toBeCloseTo(1, 3);
    });
    it('applies brevity penalty when prediction is shorter', () => {
      const score = bleu1('the cat', 'the cat sat on the mat');
      // raw precision = 1.0 but BP = exp(1 - 6/2) = exp(-2) ≈ 0.135
      expect(score).toBeLessThan(0.2);
      expect(score).toBeGreaterThan(0.1);
    });
    it('does not apply brevity penalty when prediction is longer', () => {
      // Longer prediction → BP = 1; precision = matches/predLen
      const score = bleu1('the cat sat on the mat happily', 'the cat sat on the mat');
      expect(score).toBeGreaterThan(0.85);
    });
  });

  describe('isRefusal', () => {
    it('recognises common disclaimer phrases', () => {
      expect(isRefusal('No information available.')).toBe(true);
      expect(isRefusal('The conversation does not mention this.')).toBe(true);
      expect(isRefusal("I don't know.")).toBe(true);
      expect(isRefusal('not enough information to answer')).toBe(true);
    });
    it('returns false for confident answers', () => {
      expect(isRefusal('Alice prefers cats over dogs.')).toBe(false);
      expect(isRefusal('Tuesday')).toBe(false);
    });
  });

  describe('adversarialScore', () => {
    it('rewards refusing when gold is a refusal', () => {
      expect(adversarialScore('No information available', "I don't know")).toBe(1);
    });
    it('penalises confabulation against a refusal gold', () => {
      expect(adversarialScore('Alice prefers cats', 'No information available')).toBe(0);
    });
    it('falls back to F1 when gold is not a refusal', () => {
      expect(adversarialScore('blue car', 'blue car')).toBe(1);
      expect(adversarialScore('blue car', 'red truck')).toBe(0);
    });
  });
});
