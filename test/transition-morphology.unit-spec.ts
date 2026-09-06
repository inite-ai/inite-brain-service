/**
 * Transition morphology stage (EXTRACTOR_TRANSITION_CLASSIFIER, stage
 * 1 of 2). Positive fixtures are VERBATIM battery sentences from
 * test/eval/state-transitions/scenarios.ts — the turns whose
 * transitions the extraction measurably lost; held-out fixtures appear
 * nowhere else in the repo. Expectations follow probed compromise
 * 14.16.0 behavior — limitations are documented inline, not forced.
 */
import {
  findCompletedTransitions,
  findTransitionCandidates,
  isCompletedTransition,
} from '../src/ai/extractor-internals/transition-morphology';

describe('findTransitionCandidates — battery-verbatim positives', () => {
  it('"I quit the chess club today" → completed candidate (quit, Past via zero-derivation cue)', () => {
    // s03b verbatim. Compromise limitation, handled: "quit" is
    // zero-derivation (past form spelled like the infinitive), so the
    // tagger resolves it to simple-present. The module re-resolves to
    // Past only because the clause carries the explicit past-time cue
    // "today" — a cue-less "I quit the club" stays Present by design.
    const text = 'I quit the chess club today; Mondays got too busy at work.';
    const completed = findCompletedTransitions(text);
    const quit = completed.find((c) => c.verbLemma === 'quit');
    expect(quit).toBeDefined();
    expect(quit!.tense).toBe('Past');
    expect(quit!.negated).toBe(false);
    expect(quit!.hypothetical).toBe(false);
    expect(quit!.hasComplement).toBe(true);
    // Span points back into the ORIGINAL text.
    expect(text.slice(quit!.span[0], quit!.span[1])).toContain('quit the chess club');
  });

  it('"I sold the Kawasaki today" → sold/sell, Past, not negated', () => {
    // s01b verbatim. The second clause ("no bike anymore") is verbless
    // and must contribute no analysis.
    const text = 'I sold the Kawasaki today; no bike anymore.';
    const all = findTransitionCandidates(text);
    const completed = all.filter(isCompletedTransition);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('sell');
    expect(completed[0]!.tense).toBe('Past');
    expect(completed[0]!.negated).toBe(false);
    expect(all.every((c) => !c.clause.includes('no bike'))).toBe(true);
  });

  it('"Sold the Canon R6; the Fuji stays." → elliptical subject still yields the sell candidate', () => {
    // s11b verbatim — subjectless first clause. "stays" is Present and
    // must not pass the completed filter.
    const completed = findCompletedTransitions('Sold the Canon R6; the Fuji stays.');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('sell');
  });

  it('"Boris returned the company car when he switched jobs." → two completed candidates', () => {
    // s09b verbatim — one clause, two finite past verbs.
    const lemmas = findCompletedTransitions(
      'Boris returned the company car when he switched jobs.',
    ).map((c) => c.verbLemma);
    expect(lemmas).toContain('return');
    expect(lemmas).toContain('switch');
  });

  it('"Turns out I actually cancelled my Spotify subscription back on August 1st." → cancel, Past', () => {
    // s04a verbatim — the adverb ("actually cancelled") must not break
    // lemma extraction, and "Turns out" (Present) must not pass.
    const completed = findCompletedTransitions(
      'Turns out I actually cancelled my Spotify subscription back on August 1st.',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('cancel');
  });

  it('"Moved my place of residence to Porto this week." → move, Past (elliptical subject)', () => {
    // s08b verbatim.
    const completed = findCompletedTransitions('Moved my place of residence to Porto this week.');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('move');
  });
});

describe('findTransitionCandidates — battery-verbatim negatives', () => {
  it('intention turn (s05b) → NO past-tense non-hypothetical candidate', () => {
    // s05b verbatim — the guard scenario: "thinking about selling" is
    // an intention, not a transition. "thinking" is present-progressive
    // and the governed gerund "selling" is marked hypothetical by the
    // thinking/planning-governor rule.
    const text = "I'm thinking about selling my drone, maybe next month.";
    const all = findTransitionCandidates(text);
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
    const selling = all.find((c) => c.verbLemma === 'sell');
    expect(selling).toBeDefined();
    expect(selling!.hypothetical).toBe(true);
    expect(selling!.tense).not.toBe('Past');
  });

  it('"I haven\'t sold the bike." → the sell analysis is negated', () => {
    const all = findTransitionCandidates("I haven't sold the bike.");
    const sold = all.find((c) => c.verbLemma === 'sell');
    expect(sold).toBeDefined();
    expect(sold!.negated).toBe(true);
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
  });

  it('"I never sold the bike." → adverbial negation is caught too', () => {
    const sold = findTransitionCandidates('I never sold the bike.').find(
      (c) => c.verbLemma === 'sell',
    );
    expect(sold).toBeDefined();
    expect(sold!.negated).toBe(true);
  });

  it('"I will quit next month." → Future, not Past', () => {
    const all = findTransitionCandidates('I will quit next month.');
    const quit = all.find((c) => c.verbLemma === 'quit');
    expect(quit).toBeDefined();
    expect(quit!.tense).toBe('Future');
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
  });
});

describe('findTransitionCandidates — held-out sentences (not present anywhere in the repo)', () => {
  it('"Dropped out of the yoga course." → drop out, Past (phrasal lemma, elliptical subject)', () => {
    // Inflected past forms are unambiguous, so compromise tags the
    // subjectless clause simple-past directly (unlike zero-derivation
    // "Quit …", which needs the past-time-cue re-resolution).
    const completed = findCompletedTransitions('Dropped out of the yoga course.');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('drop out');
    expect(completed[0]!.tense).toBe('Past');
  });

  it('"She cancelled her gym membership last Tuesday." → cancel, Past', () => {
    const completed = findCompletedTransitions('She cancelled her gym membership last Tuesday.');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('cancel');
  });

  it('"We ended the vendor contract with Acme." → end, Past (noun-as-verb misread stays out)', () => {
    // Compromise limitation, documented: "contract" gets a spurious
    // Present-tense verb reading. It never passes the completed filter,
    // but raw analyses may contain it — asserted here so a future
    // compromise upgrade that changes this is noticed.
    const all = findTransitionCandidates('We ended the vendor contract with Acme.');
    const completed = all.filter(isCompletedTransition);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.verbLemma).toBe('end');
  });

  it('"He was thinking of quitting." → no completed candidate (copula + governed gerund)', () => {
    // "was" is a copula (skipped outright — a past copula is not an
    // event verb) and "quitting" is a governed gerund under the
    // thinking-of rule → hypothetical.
    const all = findTransitionCandidates('He was thinking of quitting.');
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
    expect(all.every((c) => c.verbLemma !== 'be')).toBe(true);
  });

  it('"They might sell the boat." → modal makes it hypothetical, never Past', () => {
    const all = findTransitionCandidates('They might sell the boat.');
    const sell = all.find((c) => c.verbLemma === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.hypothetical).toBe(true);
    expect(sell!.tense).not.toBe('Past');
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
  });

  it('"We are planning to sell the house." → governed infinitive is hypothetical', () => {
    const all = findTransitionCandidates('We are planning to sell the house.');
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
    const sell = all.find((c) => c.verbLemma === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.hypothetical).toBe(true);
  });

  it('"He resigned." → Past but complement-less, so not a completed candidate', () => {
    // The complement rule from the design note: a candidate needs
    // non-empty object/complement material after the verb. A bare
    // intransitive stays an analysis, not a candidate.
    const all = findTransitionCandidates('He resigned.');
    const resigned = all.find((c) => c.verbLemma === 'resign');
    expect(resigned).toBeDefined();
    expect(resigned!.tense).toBe('Past');
    expect(resigned!.hasComplement).toBe(false);
    expect(all.filter(isCompletedTransition)).toHaveLength(0);
  });

  it('"I quit the club." without any time cue stays Present (documented ambiguity)', () => {
    // English morphology alone cannot decide zero-derivation past
    // without a temporal cue; the module refuses to guess. The semantic
    // stage still sees the clause via prototypes.
    const all = findTransitionCandidates('I quit the club.');
    const quit = all.find((c) => c.verbLemma === 'quit');
    expect(quit).toBeDefined();
    expect(quit!.tense).toBe('Present');
  });

  it('empty and whitespace-only input → no candidates', () => {
    expect(findTransitionCandidates('')).toEqual([]);
    expect(findTransitionCandidates('   \n ')).toEqual([]);
  });
});
