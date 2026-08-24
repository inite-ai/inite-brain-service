/**
 * Facet routing — decide which SPECIALIST extraction passes a turn deserves,
 * on top of the general one.
 *
 * WHY. One generalist prompt has to hold every contract at once: be exhaustive,
 * enumerate lists, keep proper nouns exact, resolve dates, attribute to the
 * actor. Measured on LoCoMo dev-5, the open dialogue profile wins aggregation
 * (multi-hop +8.3, single-hop +5.6) and loses precision in exactly the places
 * where two contracts compete — a list came back partial ("What books has Tim
 * read?"), and a named brand came back as its vague paraphrase ("Under Armour"
 * → "a renowned outdoor gear company"). Splitting those into passes that do ONE
 * thing removes the competition.
 *
 * WHY LOCAL, NOT AN LLM CALL. The router runs on every turn; paying an LLM
 * round-trip to decide whether to pay more LLM round-trips is the wrong shape.
 * These heuristics are deliberately CHEAP and BIASED TOWARD NOT FIRING — a
 * missed facet costs the general pass's (already decent) output, while a facet
 * that fires on every turn triples ingest cost for nothing.
 *
 * Temporal is NOT a facet: relative dates resolve downstream from the clause
 * (ingest/event-time.ts), not by a second extraction pass over the same
 * sentence.
 */
export type Facet = 'enumeration' | 'entity';

/** Words that make a comma-or-"and" sequence a LIST rather than a clause join. */
const LIST_JOINER = /,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/;

/**
 * Which specialist passes this turn warrants. Empty (the common case) → only
 * the general pass runs and behaviour is byte-identical to routing-off.
 */
export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  if (hasEnumeration(text)) facets.push('enumeration');
  if (hasNamedEntity(text)) facets.push('entity');
  return facets;
}

/**
 * A list of three or more items — the shape the general pass collapses.
 * Two items are not enough: "I went to Rome and Paris" is handled fine, while
 * "we do pottery, camping, and painting" is where items start going missing.
 * Requires an actual joiner sequence, so ordinary comma-spliced prose ("Well,
 * I think, honestly, yes") does not trip it — those fragments are too short to
 * be items.
 */
export function hasEnumeration(text: string): boolean {
  const parts = text
    .split(LIST_JOINER)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3 && p.length <= 60);
  return parts.length >= 3;
}

/**
 * A proper noun the turn names explicitly — a brand, place, title or person
 * beyond the first word of a sentence. This is the signal that the turn
 * contains something a paraphrase would DESTROY, which is precisely the
 * "Under Armour" → "a renowned outdoor gear company" failure.
 *
 * Sentence-initial capitals are excluded (every sentence has one), as are
 * the first-person "I" and common conversational openers, so "I think Sarah
 * left" trips on Sarah alone.
 */
export function hasNamedEntity(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''); // i < length
      if (w.length < 2 || w === 'I') continue;
      if (/^\p{Lu}\p{Ll}+/u.test(w)) return true;
    }
  }
  return false;
}
