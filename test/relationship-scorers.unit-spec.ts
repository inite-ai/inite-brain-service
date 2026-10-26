/**
 * Unit sanity for the relationship battery (test/eval/relationship/) —
 * its qualified-marker scorer and the shape of its corpus and probes.
 * Pure fixtures, no HTTP: the harness itself never runs in CI.
 */
import { CORPUS_TURNS } from './eval/relationship/corpus';
import { PROBES } from './eval/relationship/probes';
import { firstUnqualified, qualifiersFor, sentenceAround } from './eval/relationship/scorers';

describe('relationship scorers', () => {
  describe('sentenceAround', () => {
    it('cuts at the sentence breaks around the offset', () => {
      const text = 'She was tired last week. She is exhausted now.';
      expect(sentenceAround(text, text.indexOf('exhausted')).trim()).toBe('She is exhausted now');
    });
  });

  describe('firstUnqualified', () => {
    const past = qualifiersFor('past');

    it('passes a stale state told as past', () => {
      expect(
        firstUnqualified('Twelve days ago Ana was exhausted from work.', ['exhaust'], past),
      ).toBeNull();
    });

    it('fails a stale state told as current', () => {
      expect(firstUnqualified('Ana is exhausted and sleeping five hours.', ['exhaust'], past)).toBe(
        'Ana is exhausted and sleeping five hours',
      );
    });

    it("does not let one sentence's qualifier excuse another", () => {
      const answer = 'Ana was stressed earlier. Right now she is exhausted.';
      expect(firstUnqualified(answer, ['exhaust'], past)).toBe('Right now she is exhausted');
    });

    it('passes when no marker appears at all', () => {
      expect(firstUnqualified('Today Ana woke up excited.', ['exhaust'], past)).toBeNull();
    });

    it('requires a negation for a rejected hypothesis', () => {
      const negated = qualifiersFor('negated');
      expect(
        firstUnqualified(
          'It is not the long meetings; she snacks after sleeping badly.',
          ['meeting'],
          negated,
        ),
      ).toBeNull();
      expect(
        firstUnqualified('She snacks on days with long meetings.', ['meeting'], negated),
      ).not.toBeNull();
    });

    it('requires a hedge for an unconfirmed guess', () => {
      const hedged = qualifiersFor('hedged');
      expect(
        firstUnqualified(
          'The coach thought she might be anxious; she did not confirm.',
          ['anxious'],
          hedged,
        ),
      ).toBeNull();
      expect(firstUnqualified('Ana is anxious about work.', ['anxious'], hedged)).toBe(
        'Ana is anxious about work',
      );
    });

    it('reads typographic apostrophes as qualifiers (live answer, 2026-10-26)', () => {
      const answer =
        'You said you’re feeling upbeat today, but I don’t have evidence about whether you’re anxious.';
      expect(firstUnqualified(answer, ['anxious'], qualifiersFor('hedged'))).toBeNull();
    });
  });
});

describe('relationship corpus and probes', () => {
  it('keeps every turn under the provenance cap', () => {
    for (const turn of CORPUS_TURNS) expect(turn.text.length).toBeLessThan(600);
  });

  it('numbers turns 1..n inside each conversation and keeps them in time order', () => {
    const byConv = new Map<string, number[]>();
    for (const t of CORPUS_TURNS)
      byConv.set(t.conversation, [...(byConv.get(t.conversation) ?? []), t.turn]);
    for (const turns of byConv.values()) expect(turns).toEqual(turns.map((_, i) => i + 1));
    const ages = CORPUS_TURNS.map((t) => t.daysAgo);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });

  it('has unique probe ids and covers every check', () => {
    const ids = PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const checks = new Set(PROBES.map((p) => p.check));
    for (const c of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'A1'])
      expect(checks.has(c as never)).toBe(true);
  });
});
