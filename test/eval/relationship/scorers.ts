/**
 * Mechanical scorers of the relationship battery. Pure functions — no
 * HTTP, no LLM judge — unit-tested in
 * test/relationship-scorers.unit-spec.ts. The presence scorers are the
 * memory-fitness ones; what is new here is the QUALIFIED marker: a
 * stale state, a rejected hypothesis or an unconfirmed guess may be
 * mentioned, but only next to words that say so.
 */
export {
  containsAnyOf,
  findForbidden,
  isAbstention,
  missingKeyPhrases,
} from '../memory-fitness/scorers';

/** Words that tell a state as past. */
export const PAST_QUALIFIERS = [
  'was ',
  'were ',
  'had been',
  'earlier',
  'previously',
  'ago',
  'last week',
  'at the time',
  'back then',
  'no longer',
  'estava',
  'esteve',
  'ficou',
  'passad',
  'atrás',
  'antes',
  'naquela',
] as const;

/** Words that tell a claim as rejected. */
export const NEGATION_QUALIFIERS = [
  'not ',
  'no ',
  "n't",
  'rather than',
  'instead',
  'rejected',
  'denied',
  'disagreed',
  'ruled out',
  'não',
  'nao ',
  'em vez',
  'mas sim',
  'negou',
  'discordou',
] as const;

/** Words that tell a claim as a guess. */
export const HEDGE_QUALIFIERS = [
  'might',
  'may ',
  'maybe',
  'perhaps',
  'possibly',
  'guess',
  'hypothes',
  'unconfirmed',
  'not confirmed',
  "didn't confirm",
  'did not confirm',
  'unclear',
  'unknown',
  'no evidence',
  "don't have evidence",
  "don't know",
  'no information',
  'seems',
  'suggest',
  'wondered',
  'asked whether',
  'asked if',
  'thought',
  'talvez',
  'parece',
  'hipótese',
  'não confirm',
  'achou',
  'sei lá',
  'not sure',
] as const;

export type QualifierSet = 'past' | 'negated' | 'hedged' | 'past-or-hedged';

export function qualifiersFor(set: QualifierSet): readonly string[] {
  switch (set) {
    case 'past':
      return PAST_QUALIFIERS;
    case 'negated':
      return NEGATION_QUALIFIERS;
    case 'hedged':
      return [...HEDGE_QUALIFIERS, ...NEGATION_QUALIFIERS];
    case 'past-or-hedged':
      return [...PAST_QUALIFIERS, ...HEDGE_QUALIFIERS, ...NEGATION_QUALIFIERS];
  }
}

/**
 * The sentence around a character offset: from the last sentence break
 * before it to the next one after it. A qualifier counts only inside
 * the marker's own sentence — "She was tired last week. She is
 * exhausted." must not let the first sentence excuse the second.
 */
export function sentenceAround(text: string, index: number): string {
  const breaks = /[.!?;\n]/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(breaks)) {
    const at = m.index;
    if (at < index) start = at + 1;
    else {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}

/**
 * Every occurrence of every marker must sit in a sentence that carries
 * a qualifier. Returns the first unqualified sentence, or null.
 */
export function firstUnqualified(
  answer: string,
  markers: readonly string[],
  qualifiers: readonly string[],
): string | null {
  // Models write typographic apostrophes ("don’t"); the qualifiers are ASCII.
  // Same length, so offsets into `answer` still line up.
  const lower = answer.toLowerCase().replace(/[‘’]/g, "'");
  for (const marker of markers) {
    const needle = marker.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      const sentence = sentenceAround(lower, at);
      if (!qualifiers.some((q) => sentence.includes(q.toLowerCase()))) {
        return sentenceAround(answer, at).trim();
      }
    }
  }
  return null;
}
