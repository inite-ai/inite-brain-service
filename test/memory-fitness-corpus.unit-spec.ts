/**
 * Corpus invariants of the memory-fitness battery, with the two
 * situational axes it grew (D9 out-of-order arrival, D10 per-user
 * scope at serve time).
 *
 * Both axes are properties of how the corpus is BUILT, not of any
 * single assertion, and both break silently: if c6 stops being written
 * last, D9 stops testing arrival order and quietly becomes a second D1;
 * if the fence marker leaks into a shared turn, D10 can never pass.
 * Neither failure says anything at run time — the battery just reports
 * a number that means something else.
 */
import { CORPUS_TURNS, DIRECT_FACTS, SCOPED_FACTS } from './eval/memory-fitness/corpus';
import { QUESTIONS } from './eval/memory-fitness/questions';

const texts = CORPUS_TURNS.map((t) => t.text);
const turnsContaining = (needle: string): string[] => texts.filter((t) => t.includes(needle));

describe('memory-fitness corpus — D9, out-of-order arrival', () => {
  const c6 = CORPUS_TURNS.filter((t) => t.conversation === 'c6');

  it('writes c6 last, out of event-time order with everything after it', () => {
    // The axis is the inversion, not "oldest in the corpus" — c1 is
    // still older. What matters is that the LAST arrival is not the
    // latest event, which is the only way arrival order and event order
    // can disagree.
    expect(c6.length).toBeGreaterThan(0);
    expect(CORPUS_TURNS[CORPUS_TURNS.length - 1]!.conversation).toBe('c6');

    const latestEvent = CORPUS_TURNS.reduce((max, t) =>
      Date.parse(t.emittedAt) > Date.parse(max.emittedAt) ? t : max,
    );
    expect(latestEvent.conversation).not.toBe('c6');
  });

  it('states the superseded value later in arrival but earlier in event time', () => {
    const stale = turnsContaining('500 per run');
    const current = turnsContaining('200 per run');
    expect(stale).toHaveLength(1);
    expect(current).toHaveLength(1);

    const staleTurn = CORPUS_TURNS.find((t) => t.text.includes('500 per run'))!;
    const currentTurn = CORPUS_TURNS.find((t) => t.text.includes('200 per run'))!;

    // Arrival: stale AFTER current. Event time: stale BEFORE current.
    expect(CORPUS_TURNS.indexOf(staleTurn)).toBeGreaterThan(CORPUS_TURNS.indexOf(currentTurn));
    expect(Date.parse(staleTurn.emittedAt)).toBeLessThan(Date.parse(currentTurn.emittedAt));
  });

  it('keeps chain E out of every other question', () => {
    // A D9 failure must not blur D1's signal, so nothing else may ask
    // about the batch size.
    const others = QUESTIONS.filter((q) => q.dimension !== 'D9');
    const mentions = others.filter((q) => /batch size/i.test(q.prompt));
    expect(mentions.map((q) => q.id)).toEqual([]);
  });
});

describe('memory-fitness corpus — D10, per-user scope at serve time', () => {
  it('scopes at least one fact away from the battery user', () => {
    expect(SCOPED_FACTS.length).toBeGreaterThan(0);
  });

  it('gives the fence a marker that exists nowhere else in the corpus', () => {
    // A leak has to be unmistakable: if the marker also appeared in a
    // shared turn, the negative half could never pass and the positive
    // half could pass without the fence doing anything.
    for (const fact of SCOPED_FACTS) {
      const marker = fact.object;
      expect(turnsContaining(marker)).toEqual([]);
      expect(DIRECT_FACTS.filter((f) => f.object === marker)).toEqual([]);
    }
  });

  it('asks both halves in one question', () => {
    const fence = QUESTIONS.filter((q) => q.kind === 'scope-fence');
    expect(fence.length).toBeGreaterThan(0);
    for (const q of fence) {
      // Positive half (owner must see it) and negative half (nobody else
      // may) — a fence that answers nobody must not score as a pass.
      expect(q.expectAnyOf.length).toBeGreaterThan(0);
      expect(q.forbidForOthers.length).toBeGreaterThan(0);
    }
  });
});

describe('memory-fitness corpus — shared invariants', () => {
  it('every question id is unique', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every dimension a question claims has a question', () => {
    const claimed = new Set(QUESTIONS.map((q) => q.dimension));
    expect([...claimed].sort()).toEqual([
      'D1',
      'D10',
      'D2',
      'D3',
      'D4',
      'D5',
      'D6',
      'D7',
      'D8',
      'D9',
    ]);
  });

  it('keeps every turn under the provenance text cap', () => {
    // Over 600 chars and a seeded fragment can be truncated away, which
    // fails a provenance check for a reason that has nothing to do with
    // memory.
    const tooLong = CORPUS_TURNS.filter((t) => t.text.length > 600).map((t) => t.conversation);
    expect(tooLong).toEqual([]);
  });
});
