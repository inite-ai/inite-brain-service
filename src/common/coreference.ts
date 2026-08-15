/**
 * Speaker coreference helpers for multi-speaker ingestion.
 *
 * When a turn is spoken by a known participant, first-person references
 * ("I", "me", "my") denote that speaker and second-person ("you", "your")
 * denotes the addressee. A naive extractor emits these pronouns as their
 * OWN entities ("I", "you", "the woman"), scattering a person's attributes
 * across junk nodes and breaking entity-centric retrieval.
 *
 * These helpers classify an extracted entity name so the ingest path can
 * redirect it to the real participant (via the known-entity externalRef
 * hint) instead of minting a pronoun node. This is the industry-standard
 * approach (LoCoMo serializes `Speaker said …`; Graphiti bans pronoun
 * nodes and resolves them; Mem0 replaces pronouns with the speaker name).
 *
 * Scope, deliberately conservative:
 *   - First-person SINGULAR → the speaker. Unambiguous.
 *   - Second-person → the addressee, only when the party set is known.
 *   - First-person PLURAL ("we", "us", "our") is NOT mapped: it means
 *     "speaker + others" and force-attributing it to the speaker alone
 *     would be wrong ("we got married" must not become the speaker's solo
 *     fact). Left to normal resolution.
 *   - Bare definite descriptions ("the woman") are NOT handled here —
 *     they need real cross-turn coreference; left to inline
 *     entity-resolution.
 */

/** First-person singular self-references → the speaker. */
const FIRST_PERSON_SINGULAR = new Set([
  'i',
  'me',
  'my',
  'mine',
  'myself',
]);

/** Second-person references → the addressee (when known). */
const SECOND_PERSON = new Set([
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

function normalizeToken(name: string): string {
  return name.trim().toLowerCase().replace(/[.,!?;:'"]+$/, '');
}

/** True when the entity name is a bare first-person-singular pronoun. */
export function isFirstPersonSelfReference(name: string): boolean {
  return FIRST_PERSON_SINGULAR.has(normalizeToken(name));
}

/** True when the entity name is a bare second-person pronoun. */
export function isSecondPersonReference(name: string): boolean {
  return SECOND_PERSON.has(normalizeToken(name));
}

/**
 * Case-insensitive match of an extracted entity name against a known
 * participant's display name — catches a speaker who refers to themselves
 * (or is referred to) by name in the third person, which would otherwise
 * mint a duplicate node separate from the registered participant entity.
 */
export function matchesParticipantName(
  name: string | undefined,
  participantName: string | undefined,
): boolean {
  if (!name || !participantName) return false;
  return normalizeToken(name) === normalizeToken(participantName);
}
