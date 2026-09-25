import type { PredicateDefinition } from '../predicate-registry.service';
import type { PackExtractionProfile } from '../predicate-registry-internals/types';
import { ENTITY_TYPE_VOCABULARY } from './types';
import { renderMemoryContext, type MemoryContext } from './memory-context';

/**
 * Static header — the structural / verbatim-rule / decompose-then-extract
 * contract. Predicate cards are appended dynamically per call from the
 * tenant's predicate registry snapshot, so adding a new predicate in
 * the registry immediately propagates to the prompt without code changes.
 */
export const EXTRACTION_PROMPT_HEADER = `You are an entity-and-fact extractor for a knowledge graph.

OUTPUT CONTRACT
You output JSON with four top-level fields, in this order:

  1. clauses[] — verbatim sub-spans of the input. Each entry is ONE independent
     assertion. A sentence with two conjuncts ("X is the CTO and prefers vegan
     lunch") produces TWO clauses, not one. A two-sentence input produces at
     least two clauses. Copy each clause verbatim from the input — never
     summarise or rephrase.

  2. entities[] — actors named in the input. Each entry has name (verbatim
     mention), type (closed enum: ${ENTITY_TYPE_VOCABULARY.join(', ')}), and
     canonical: the form the entity is KNOWN by, when the mention is not it —
     the dictionary form of an inflected mention (nominative, singular:
     "Марией Петровой" → "Мария Петрова", "Лиссабона" → "Лиссабон"), the full
     name when this input gives it ("Артёма" → "Артём Соколов"), or the
     legal/registered form when the text states it; null when the mention
     already is that form. name stays verbatim — canonical is what the
     graph will file the entity under.

  3. facts[] — assertions about the entities. Each fact has:
       entityIndex   — 0-based index into entities[]
       clauseIndex   — 0-based index into clauses[] (the clause warranting this fact)
       predicate     — chosen from the closed predicate vocabulary
       valueSpan     — VERBATIM SUBSTRING of the input naming the value
       confidence    — 0..1, reserve >0.8 for explicit assertions, 0.5–0.8 for inferred

  4. edges[] — entity-to-entity relationships the input asserts. A fact captures
     an attribute of ONE entity (Maria.address=Berlin); an edge captures a
     LINK between TWO named entities (Maria works_at Acme). Each edge has:
       fromEntityIndex — 0-based index into entities[] (source)
       toEntityIndex   — 0-based index into entities[] (target)
       kind            — lowercase snake_case relationship type (works_at,
                         lives_at, affiliated_with, owns, knows, ...)
       clauseIndex     — 0-based index into clauses[]
       confidence      — 0..1
       eventTime       — YYYY-MM-DD the relation began to hold, or null
       endTime         — YYYY-MM-DD it stopped holding, or null (see MEMORY)

     Emit an edge whenever the text places one named entity in relation to
     another. "X is the CTO at Y" → edge (X, works_at, Y). "X joined Y" →
     edge (X, works_at, Y). "X owns Y" → edge (X, owns, Y). "X lives in Y"
     where Y is a named location → edge (X, lives_at, Y) IN ADDITION to the
     address fact (the fact carries the value, the edge carries the link).

     Closed vocabulary is preferred when applicable; coin a new kind only
     when none fits. Edges that the text does not warrant are dropped server-
     side via the bounds check on entityIndex.

THE VERBATIM RULE (most important):
  valueSpan MUST appear character-for-character somewhere in the input.
  • Copy from the source. Do not paraphrase.
  • Do not substitute a synonym, a normalised form, or a canonical label.
  • Do not use any word from THESE INSTRUCTIONS that doesn't appear in the input.
  • The server validates substring containment and drops any fact whose
    valueSpan is not found. A dropped fact is worse than a missing fact.
  • If you cannot find a substring of the input that names the value, do not
    emit the fact.

PREDICATE SELECTION (closed-preferred, open-coined)
For each clause, pick the SINGLE most specific predicate from the vocabulary
below. Each predicate card encodes its TYPE / ADMIT / NOT FOR / VALUE rules
— read them carefully before choosing.

If — and ONLY if — no listed predicate admits the clause, you may coin a
new predicate. Constraints on a coined predicate:
  • lowercase snake_case, single noun-phrase ("hobby", "citizenship",
    "preferred_pronoun", "medication_taken"). NOT verb phrases.
  • Must describe the SHAPE of the assertion, not a specific value.
  • Use this only when the existing vocab is genuinely the wrong slot for
    the clause — not as a paraphrase preference. The server runs an EDC
    similarity check downstream and will auto-alias your coined predicate
    to an existing one when they overlap; if the coin survives, it's
    proposed for review.
A coined predicate must NOT be a verb ("eats", "lives") — pick the
existing predicate whose TYPE describes that assertion (preference,
address, etc.) instead.

GENERAL RULES
  • Each clause produces zero or more facts. A clause that asserts no
    extractable predicate produces ZERO facts. This explicitly includes
    contentless social utterances — greetings ("Hey Mel!"), acknowledgements
    and backchannels ("That's great!", "Wow, nice!", "lol same"), thanks,
    and questions that assert nothing ("How's it going?"). Do NOT emit a
    "said" fact for these; the said predicate is for an utterance that carries
    real content no more-specific predicate captures, never for small talk.
  • Multiple distinct assertions about the same subject — even in a single
    sentence — each get their own fact.
  • Skip entities that appear only as pronouns with no resolvable antecedent.
  • temperature is near-zero; pick the predicate the type-signatures admit,
    not the predicate that's "close enough".
  • The output JSON schema is strict — fields that don't conform are rejected
    by the runtime. valueSpan grounding is enforced server-side.

PREDICATE VOCABULARY
`;

/**
 * Dialogue extraction header (Phase 4 v2, EXTRACTOR_DIALOGUE_PROFILE). Rebuilt
 * from the 3-way SOTA convergence (Mem0 additive-extraction, Graphiti combined
 * extractor, EDC / Dense-X / "conservative bias" literature):
 *   • NO closed predicate vocabulary in the prompt — a closed label set as the
 *     output contract IS the cause of catch-all collapse ("conservative bias":
 *     LLMs retreat to a safe generic label ~2× more than they hallucinate).
 *     The LLM coins a SPECIFIC predicate; canonicalization to the registry
 *     happens downstream (EDC), never here. buildDialogueSystemPrompt therefore
 *     appends NO predicate cards.
 *   • The value is a SELF-CONTAINED, specificity-PRESERVING statement, not a
 *     bare token — v1's "shrink to 'sunset'" over-compressed and lost the
 *     recall drivers every SOTA system keeps ("aerial yoga" not "yoga";
 *     Graphiti/Mem0 both forbid generalizing). Retrieval embeds this fact text
 *     (Graphiti embeds `fact`, not the predicate), so open predicates don't hurt
 *     recall.
 *   • Attribute to the ACTOR, enumerate lists, and be exhaustive (Mem0's
 *     "when in doubt, extract" — dedup is downstream).
 * Output SCHEMA is unchanged (clauses/entities/facts/edges); grounding's
 * substring-drop is bypassed for this profile (values are normalized, not spans).
 */
export const EXTRACTION_PROMPT_HEADER_DIALOGUE = `You extract durable MEMORY facts from a turn of personal conversation, for a knowledge graph an AI will search later to answer questions. The original conversation will NOT be available at retrieval time — ONLY the facts you extract survive. So be exhaustive, specific, and self-contained.

OUTPUT CONTRACT — JSON with four top-level fields, in this order:

  1. clauses[] — verbatim sub-spans of the input, ONE independent assertion each.

  2. entities[] — the NAMED things involved: people, organisations, places,
     and products / projects / systems / documents the turn calls by a name.
     Resolve pronouns and roles to who they refer to — NEVER a bare
     "I"/"you"/"the woman". A generic noun, a role, a date, a group or an
     unnamed thing ("the report", "the board", "Friday", "the pilot",
     "brokers") is NOT an entity when a named one is there to carry the
     fact — it becomes the value of a fact on the named entity it belongs
     to (a KNOWN ENTITY, one the turn names, or the speaker). Only when the
     turn names nothing and no speaker is known does the described thing
     itself become the entity ("pilot launch" as a project), so the fact is
     never lost. type (closed enum: ${ENTITY_TYPE_VOCABULARY.join(', ')}).
     canonical = the form the entity is known by when the mention is not it:
     the dictionary form of an inflected mention (nominative singular —
     "Марией" → "Мария"), the full name when the turn gives it, or the stated
     legal form; null when name already is it. known = see MEMORY below.

  3. facts[] — durable facts. Each: entityIndex, clauseIndex, predicate, valueSpan,
     confidence (0..1; >0.8 explicit, 0.5–0.8 inferred).

  4. edges[] — entity-to-entity links: (X, works_at, Y), (X, owns, Y), (X, knows, Y),
     (X, lives_at, Y). kind = lowercase snake_case. Link two named people with an
     EDGE, not a fact routed through scenery. A possessive asserts a relation that
     outlives the sentence: "my apartment in Riga", "our office in Lisbon", "her
     Kawasaki" → an edge (owner, owns, thing) besides whatever the clause says
     about the thing (listing it for sale does not end the ownership).
     Each edge also carries eventTime and endTime (see MEMORY).

predicate — COIN A SPECIFIC ONE (there is no fixed list to choose from):
  Write the most specific relationship label as lowercase snake_case, derived from
  the clause: painted, researched, adopted, visited, relationship_status,
  favorite_book, plays_instrument, kids_like, works_as, volunteers_at. Do NOT fall
  back to vague catch-alls (preference, intent, interacted_with, status, did, said) —
  they erase the meaning that makes a fact findable. A self-referencing fact ("I love
  hiking" → hobby = "hiking") is good — with a SPECIFIC predicate.

valueSpan — a CLEAN, SELF-CONTAINED value that PRESERVES SPECIFICITY:
  Understandable on its own; pronouns replaced with the entity's name.
  • KEEP every concrete noun, number, brand, title, and qualifier. NEVER generalize:
      "aerial yoga" NOT "yoga"; "assistant manager" NOT "manager";
      "Ferrari 488 GTB" NOT "car"; "adoption agencies" NOT "agencies".
  • Strip filler, quotes, and reaction words; keep the concrete value.
  • It need NOT be a substring of the input — write the clean, faithful value.
  • Preserve meaning: "didn't get to bed until 2am" = late bedtime, not "slept until 2am";
    "used to love hiking" = no longer, not currently.

ATTRIBUTE TO THE ACTOR, NOT THE SPEAKER:
  A statement ABOUT someone is a fact about THAT person. A→B "You captured the sunset
  perfectly!" about B's painting → entity B, predicate painted, value "a sunset".
  B→A "your kids must love dinosaurs" → A's kids, kids_like = "dinosaurs". Never store
  one person's reaction as the speaker's own preference.

ENUMERATE — never collapse a list:
  "we do pottery, camping, and painting" → THREE facts (hobby="pottery",
  hobby="camping", hobby="painting"), never one. Every list item gets its own fact.

BE EXHAUSTIVE (recall matters more than brevity):
  When in doubt, EXTRACT — a redundant fact costs far less than a missing one; dedup
  happens downstream. Cover EVERY distinct assertion in the turn, not just the first —
  do not stop after the first topic. Only skip contentless social utterances: greetings,
  acknowledgements, backchannels ("That's great!", "lol same"), thanks, and questions
  that assert nothing. NEVER emit a "said" fact for those.

  • Near-zero temperature; the strict JSON schema is enforced by the runtime.
`;

/**
 * The memory contract — appended to BOTH headers. It explains the
 * output fields that tie an extraction to what the graph already holds
 * (`known`, `supersedes`, the `eventTime`/`endTime` period a fact's value
 * or an edge's relation held, and a temporary state's `expectedEnd`), the
 * entity policy those fields
 * assume, and the one predicate the serving side reads by name
 * (`instruction`). The matching user-message sections are rendered by
 * renderMemoryContext; the schema fields are added by
 * buildExtractionSchema in lockstep.
 */
export const MEMORY_CONTRACT_SECTION = `
MEMORY
The user message may open with TURN DATE, CONVERSATION SO FAR, KNOWN ENTITIES,
KNOWN FACTS and KNOWN PREDICATES sections, then CURRENT TURN. Extract from the
CURRENT TURN only; the rest is what the memory already holds.

  known (per entity) — the handle of the KNOWN ENTITY this mention refers to
  ("e2"), else null. The same person or organisation by a shorter, inflected or
  transliterated name, a first name after the full name, a nickname or a role
  the conversation already tied to them → the known one. A KNOWN ENTITY is never
  created again under another name. name stays the mention as the turn wrote it
  ("Rui"); known says who that is.

  A value is never a bare pronoun or a phrase whose object is one ("it", "her",
  "covers for her"): name the thing, or state the link as an edge instead.

  Attach each fact to the entity it is ABOUT — the one the KNOWN FACTS of that
  attribute already sit on. A deal's budget, start date and decision belong to
  the client, not to a "pilot" or a "proposal"; a rule about someone's contact
  hours belongs to that person. A turn that names nobody still yields its
  facts: on the KNOWN ENTITY the conversation is about, else on the speaker,
  else on the described thing itself as the entity.

  supersedes (per fact) — handles of KNOWN FACTS and relations this fact
  replaces: a new value of the same attribute ("budget 4000" → "2500"), a
  moved date, a changed state, a correction, the relation that stated the old
  value ("moved to Hetzner" closes "runs_on → Fly.io") — even when the known
  fact's predicate is spelled differently. A fact that adds a different
  attribute supersedes nothing.
  Empty when nothing changes. When a KNOWN FACT stops holding ("Redis is no
  longer the queue", "I sold the Kawasaki", "this supersedes the March
  decision"), the fact the turn states — the new value, or what ended it
  (sold: "Kawasaki") — lists that known fact's handle in supersedes; the
  ended value is not restated as a positive fact of its own. endTime is for
  a past value first stated in the CURRENT TURN together with its end. A
  KNOWN FACT shown "until" a day is history: supersede it only to correct it.

  eventTime (per fact) — the calendar day (YYYY-MM-DD) the value refers to: a
  deadline, a meeting, a start, when something happened or will happen —
  resolved against TURN DATE. null when the clause names no day. The value
  itself stays as written ("19 сентября"); eventTime carries the resolved day.

  eventTime, endTime (per fact and per edge) — the period the value or the
  relation held, resolved against TURN DATE. eventTime as above ("since the
  24th", "joined in March"). endTime: the day THIS value or relation stopped
  holding — "ran on A until the 24th", "moved from X to Y on the 24th" ends
  A / X that day; null while it still holds. A value that itself says
  something ended or is gone ("sold", "no bike anymore", "the experiment is
  over") holds FROM that day: eventTime, never endTime. "Until the 24th X
  ran on A; from the 24th on B" → both are emitted: A with endTime 24th, B
  with eventTime 24th (as facts, and as (X, runs_on, …) edges).

  expectedEnd (per fact) — only for a TEMPORARY state the subject is in: an
  illness or injury, a trip, a stay or visit somewhere, being away, on leave or
  busy with something for a while, when the clause names no end (a stated end —
  "until Friday", "this week" — is endTime). The day it would ordinarily be
  over, judged from what the state is and resolved against TURN DATE (a cold:
  about a week; a conference trip: its usual few days). null for everything
  that holds until something changes it (a job, a home, a relationship, a
  preference, a setting, a plan, a decision), for something that happened,
  for a state with no ordinary length, and whenever endTime is set. A KNOWN
  FACT marked "(expected until …)" is such a state: a turn saying it still
  holds states it again with a new expectedEnd; a turn saying it is over
  supersedes it.

  cardinality (per fact) — can the subject hold several of these at once?
  "one": no — a SETTING or a STATE it is in (where it runs, its budget, a
  deadline, its status, its address, its CTO): a later value replaces the
  earlier one. "many": yes — something that HAPPENED (sent, moved, requested,
  stood up), an observation, a wish or intent, a preference, a capability, a
  responsibility or any other link to another entity that does not exclude
  other links, a standing instruction. The value being a thing and the clause
  narrating an action decide nothing; the plural does: "its deploy targets"
  is wrong, "its dependencies", "its responsibilities", "its instructions"
  read naturally → "many". When both readings hold, "many".

  instruction — a standing instruction to the assistant about how to act,
  answer, write or format from now on ("запомни: …", "always …", "never …",
  "when I ask …", "write reports for X in Portuguese") is a fact with predicate
  "instruction", attached to the speaker (or, when it concerns one named party,
  to that party), value = the instruction as one self-contained sentence.
`;

export function renderPredicateCard(p: PredicateDefinition): string {
  return `\n${p.predicateId} [${p.semantics}]\n${p.description.trim()}\n`;
}

/**
 * Dialogue-profile system prompt (Phase 4 v2): the open header ALONE — NO
 * predicate cards. Showing the closed vocab is exactly what causes catch-all
 * anchoring, so the extractor runs fully open; the registry vocabulary is
 * applied later by the canonicalization step, not shown to the extractor.
 * `predicates` is intentionally unused (kept for signature parity with
 * buildSystemPrompt).
 */
export function buildDialogueSystemPrompt(_predicates: PredicateDefinition[]): string {
  return EXTRACTION_PROMPT_HEADER_DIALOGUE + MEMORY_CONTRACT_SECTION;
}

/**
 * Facet-specialist instructions, appended to the dialogue header for a single
 * extra pass (EXTRACTOR_ROUTING_ENABLED). Each one narrows the job to ONE
 * contract so it stops competing with the other four in a single call — the
 * general pass still runs, and the union is deduplicated downstream, so a
 * facet can only ADD recall, never remove it.
 */
const FACET_INSTRUCTIONS: Record<string, string> = {
  enumeration: `
=== THIS PASS: LIST ITEMS ONLY ===
Ignore everything that is not an enumeration. Find every list in the turn and emit ONE FACT PER ITEM — never a single fact holding a joined list, never a summary of the list.
  "we do pottery, camping, and painting" → THREE facts.
  "I've read The Hobbit, Dune and most of Discworld" → THREE facts, each with the title as the value.
Repeat the same predicate across the items of one list; the items are what differ. Missing an item is the failure mode this pass exists to prevent, so err toward emitting one more.
If the turn contains no list, return empty facts.`,
  entity: `
=== THIS PASS: NAMED THINGS ONLY ===
Ignore everything that is not anchored to a PROPER NAME — a person, brand, product, place, organisation, book, film or team the turn names explicitly.
Emit the name EXACTLY as written. Never substitute a description for a name:
  "Under Armour" NOT "a renowned outdoor gear company"; "the UK" NOT "Europe";
  "The Name of the Wind" NOT "a fantasy book".
If the turn refers to something only by description and never names it, DO NOT emit a fact for it — that is the general pass's job, not this one.
If the turn names nothing, return empty facts.`,
};

/**
 * The system prompt for one specialist pass. An unknown facet degrades to the
 * plain dialogue prompt (a redundant general pass), which the union dedupes —
 * never an error.
 */
export function buildFacetSystemPrompt(facet: string): string {
  return (
    EXTRACTION_PROMPT_HEADER_DIALOGUE + MEMORY_CONTRACT_SECTION + (FACET_INSTRUCTIONS[facet] ?? '')
  );
}

/** Conversation participants for one turn — drives coreference resolution. */
export interface ConversationContext {
  /** Who is speaking this turn. First-person refers to them. */
  speakerName?: string;
  /**
   * The speaker is the user this memory is captured for (participants.ts):
   * the turn is theirs unless it attributes words to someone else, and
   * "the user" in a recorder's framing means them.
   */
  speakerIsUser?: boolean;
  /** Who they address. Second-person ("you") refers to them. */
  addresseeName?: string;
  /**
   * What the memory already holds around this turn (memory-context.ts):
   * the earlier turns, the known entities and their facts, the tenant's
   * predicates. Rendered ahead of the turn; its handles come back on
   * the extraction as `known` / `supersedes`.
   */
  memory?: MemoryContext | undefined;
}

/**
 * Render the per-turn speaker framing prepended to the user message. This
 * is the single highest-leverage fix for pronoun-entity scatter: told who
 * is speaking, the extractor attributes "I decided to transition" to the
 * speaker instead of minting a junk "I" node. Mirrors LoCoMo's `Speaker
 * said, "…"` serialization, Graphiti's pronoun ban, and Mem0's
 * "replace pronouns with the speaker name" rule.
 *
 * Returns '' when no speaker is known, so the extractor input is
 * byte-identical to the pre-coreference behaviour.
 */
export function buildConversationContext(ctx: ConversationContext): string {
  return buildSpeakerFraming(ctx) + renderMemoryContext(ctx.memory);
}

function buildSpeakerFraming(ctx: ConversationContext): string {
  if (!ctx.speakerName) return '';
  const name = ctx.speakerName;
  const addressee = ctx.addresseeName ? `, addressing "${ctx.addresseeName}"` : '';
  const secondPerson = ctx.addresseeName
    ? ` Second-person ("you", "your") refers to "${ctx.addresseeName}".`
    : '';
  // The user's own turn: what a recorder calls "the user" is them too,
  // and words the turn puts in someone else's mouth stay that person's.
  const who = ctx.speakerIsUser
    ? `This turn is by "${name}", the user this memory belongs to${addressee}. ` +
      `First-person references ("I", "me", "my", "myself") and "the user" refer to "${name}"`
    : `This turn was spoken by "${name}"${addressee}. ` +
      `First-person references ("I", "me", "my", "myself") refer to "${name}"`;
  return (
    `CONVERSATION CONTEXT\n` +
    `${who} — ` +
    `emit "${name}" as the entity for the speaker's own statements, NEVER a bare "I"/"me"/"user" node, ` +
    `and attach the speaker's self-facts to it rather than to a topic or description entity from the same clause. ` +
    `Words the turn attributes to someone else ("Ana said …", a line labelled "Ana: …") are that person's — ` +
    `a first person inside them is theirs.` +
    secondPerson +
    ` Never create an entity whose name is a bare pronoun or a bare definite description ("the woman", "my ex"); ` +
    `resolve it to the participant it refers to. Do NOT map group "we"/"us" to a single person.\n\n`
  );
}

/**
 * Object-normalization section (EXTRACTION_OBJECT_NORMALIZE). Appended
 * after the predicate vocabulary; the schema gains a required nullable
 * `object` field in lockstep (buildExtractionSchema). Fixes the measured
 * aggregation failure: raw verbal spans as stored objects ("camped in
 * the mountains with my kids") scatter the same value across phrasings,
 * so "list all X" questions cannot converge. The span stays the
 * grounding anchor; the object is the retrieval value.
 */
export const OBJECT_NORMALIZATION_SECTION = `
NORMALIZED OBJECT (in addition to valueSpan)
For each fact, also emit "object": the MINIMAL clean phrase naming the
value — strip surrounding verbs, possessives, temporal modifiers, and
subordinate clauses from the valueSpan.
  • Every word of object MUST already appear inside valueSpan. Do not
    introduce new words, synonyms, or canonical labels — the server
    validates word containment and falls back to the raw span otherwise.
  • Keep specificity: "aerial yoga" stays "aerial yoga", never "yoga".
  • valueSpan "camped in the mountains with my kids" → object "the mountains".
  • valueSpan "really loves the new espresso machine" → object "espresso machine".
  • When the span already IS the minimal value, set object to null.
`;

export function buildSystemPrompt(
  predicates: PredicateDefinition[],
  opts?: { objectNormalization?: boolean },
): string {
  return (
    EXTRACTION_PROMPT_HEADER +
    predicates.map(renderPredicateCard).join('\n') +
    (opts?.objectNormalization ? OBJECT_NORMALIZATION_SECTION : '') +
    MEMORY_CONTRACT_SECTION
  );
}

/**
 * Render the tenant's active Domain Pack extraction profiles as a trailing
 * system-prompt section. Returns '' when no pack ships a profile (the common
 * case), so the prompt is byte-identical to pre-pack behaviour. Placed AFTER
 * the predicate vocabulary: guidance + few-shot reinforce how to read a
 * domain's text, but the VERBATIM RULE and strict schema in the header still
 * govern — this block is advisory.
 */
export function renderExtractionProfiles(profiles: PackExtractionProfile[]): string {
  const withContent = profiles.filter(
    (p) => p.profile.guidance || (p.profile.fewShot?.length ?? 0) > 0,
  );
  if (withContent.length === 0) return '';
  const blocks = withContent.map(({ packId, profile }) => {
    const parts: string[] = [`[pack: ${packId}]`];
    if (profile.guidance) parts.push(profile.guidance.trim());
    if (profile.fewShot?.length) {
      parts.push('EXAMPLES');
      for (const ex of profile.fewShot) {
        parts.push(`• "${ex.text}"\n    → ${ex.note}`);
      }
    }
    return parts.join('\n');
  });
  return (
    '\n\nDOMAIN EXTRACTION GUIDANCE\n' +
    'Installed domain packs contribute the domain-specific guidance below. ' +
    'Apply it when the input matches the domain. It NEVER overrides the ' +
    'VERBATIM RULE or the strict output schema above.\n\n' +
    blocks.join('\n\n') +
    '\n'
  );
}

/**
 * Strict JSON schema mirror of the prompt's output contract.
 * `objectNormalization` adds the required-nullable `object` field in
 * lockstep with OBJECT_NORMALIZATION_SECTION; off → byte-identical
 * schema (strict mode forces every property into `required`, so the
 * field cannot simply be optional).
 */
export function buildExtractionSchema(opts?: {
  objectNormalization?: boolean;
}): Record<string, unknown> {
  const objectProperty = opts?.objectNormalization
    ? {
        object: {
          type: ['string', 'null'],
          description:
            'MINIMAL clean phrase naming the value, made ONLY of words already inside valueSpan (server-validated); null when the span already is the minimal value.',
        },
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      clauses: {
        type: 'array',
        description:
          'Verbatim sub-spans of the input, each one independent assertion. Decompose-then-extract step.',
        items: { type: 'string' },
      },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...ENTITY_TYPE_VOCABULARY] },
            canonical: {
              type: ['string', 'null'],
              description:
                'The form the entity is known by when the mention is not it: dictionary form of an inflected mention (nominative singular), the full name when this input gives it, or the stated legal form. null when name already is that form.',
            },
            known: {
              type: ['string', 'null'],
              description: 'Handle of the KNOWN ENTITY this mention refers to ("e2"), else null.',
            },
          },
          required: ['name', 'type', 'canonical', 'known'],
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entityIndex: { type: 'integer', minimum: 0 },
            clauseIndex: { type: 'integer', minimum: 0 },
            predicate: {
              type: 'string',
              description:
                'Prefer a predicate from the listed vocabulary. Coin a new lowercase snake_case predicate ONLY when no listed one admits the clause — the server will canonicalize it via EDC similarity search downstream.',
            },
            valueSpan: {
              type: 'string',
              description:
                'VERBATIM substring of the input naming the object value. Server validates substring containment; ungrounded facts are dropped.',
            },
            ...objectProperty,
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            eventTime: {
              type: ['string', 'null'],
              description:
                'YYYY-MM-DD the value refers to (deadline, meeting, occurrence), resolved against TURN DATE; null when the clause names no day.',
            },
            endTime: {
              type: ['string', 'null'],
              description:
                "YYYY-MM-DD this value stopped holding when the clause says it ended or was replaced ('ran on A until the 24th', 'moved from X to Y on …' ends X); null while it holds, and null for a value that itself states an ending ('sold', 'no longer has it', 'is over' — that value begins then: eventTime).",
            },
            expectedEnd: {
              type: ['string', 'null'],
              description:
                'YYYY-MM-DD a TEMPORARY state (illness, trip, stay, being away or busy) whose end the clause does not name would ordinarily be over, resolved against TURN DATE; null for anything that holds until changed, and when endTime is set.',
            },
            supersedes: {
              type: 'array',
              description:
                'Handles of KNOWN FACTS this fact replaces ("m3"); empty when nothing changes.',
              items: { type: 'string' },
            },
            cardinality: {
              type: 'string',
              enum: ['one', 'many'],
              description:
                'How many values of this attribute the subject holds at one time: "one" (a setting or state — a later value replaces it) or "many" (several coexist).',
            },
          },
          required: [
            'entityIndex',
            'clauseIndex',
            'predicate',
            'valueSpan',
            ...(opts?.objectNormalization ? ['object'] : []),
            'confidence',
            'eventTime',
            'endTime',
            'expectedEnd',
            'supersedes',
            'cardinality',
          ],
        },
      },
      edges: {
        type: 'array',
        description:
          'Entity-to-entity relationships. Bridge two named entities. "Maria is CTO at Acme" → edge (Maria, works_at, Acme). Without edges, graph traversal cannot reach Maria from Acme.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fromEntityIndex: { type: 'integer', minimum: 0 },
            toEntityIndex: { type: 'integer', minimum: 0 },
            kind: {
              type: 'string',
              description:
                'Lowercase snake_case relationship type. Common: works_at, lives_at, affiliated_with, owns, knows, located_in.',
            },
            clauseIndex: { type: 'integer', minimum: 0 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            eventTime: {
              type: ['string', 'null'],
              description:
                'YYYY-MM-DD the relation began to hold, resolved against TURN DATE; null when the clause names no day.',
            },
            endTime: {
              type: ['string', 'null'],
              description:
                "YYYY-MM-DD the relation stopped holding when the clause says it ended or was replaced ('until the 24th', 'no longer', 'moved from X to Y on …'); null while it still holds.",
            },
          },
          required: [
            'fromEntityIndex',
            'toEntityIndex',
            'kind',
            'clauseIndex',
            'confidence',
            'eventTime',
            'endTime',
          ],
        },
      },
    },
    required: ['clauses', 'entities', 'facts', 'edges'],
  };
}
