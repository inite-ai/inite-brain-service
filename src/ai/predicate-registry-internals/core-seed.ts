import type { PredicateDefinition } from './types';

/**
 * Bootstrap seed — the canonical set of predicates inserted into a
 * tenant on first access. Treat as the equivalent of an OWL ontology
 * file: shape + policy + description live together, version-controlled
 * with the code.
 *
 * Adding a new core predicate:
 *   1. Append an entry below.
 *   2. Redeploy. On next ingest in any tenant, the new row is INSERTed
 *      by ensureBootstrap. Existing predicates are NOT touched (so
 *      admin overrides survive redeploys).
 *
 * The description field is the system-prompt card for the extractor —
 * it's how the LLM knows when to admit this predicate.
 */
export const CORE_PREDICATES: PredicateDefinition[] = [
  // ── EVENT / utterance ────────────────────────────────────────────────
  {
    predicateId: 'said',
    displayLabel: 'said',
    description: `TYPE   subject is anyone; value is an attributed utterance
ADMIT  text directly attributes an utterance to the subject AND no more
       specific predicate (intent / complained_about / preference) admits
       the clause. Fallback predicate — prefer specifics.
VALUE  the utterance span (may be a quoted string)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 30,
    piiClass: 'text',
    status: 'active',
    createdBy: 'system',
  },

  // ── IDENTITY (functional, lifetime-stable) ───────────────────────────
  {
    predicateId: 'name',
    displayLabel: 'name',
    description: `TYPE   subject is any entity; value is the proper noun naming it
ADMIT  text introduces or names the entity (proper noun, not pronoun)
NOT FOR a pronoun reference alone — skip the fact
VALUE  the proper-noun span from the input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'email',
    displayLabel: 'email',
    description: `TYPE   subject is a person/org; value is an email address
ADMIT  a literal email address appears, attributed to this subject
VALUE  the literal email-address span`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'phone',
    displayLabel: 'phone',
    description: `TYPE   subject is a person/org; value is a phone number
ADMIT  a literal phone-number span appears, attributed to this subject
VALUE  the literal phone-number span`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'identifier',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'dob',
    displayLabel: 'date of birth',
    description: `TYPE   subject is a person; value is a date of birth
ADMIT  text states when the subject was born
VALUE  the date span from the input`,
    datatype: 'date',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'sensitive',
    requiresScope: 'brain:read_pii',
    status: 'active',
    createdBy: 'system',
  },

  // ── SINGLE-STATE (functional, time-varying) ──────────────────────────
  {
    predicateId: 'status',
    displayLabel: 'status',
    description: `TYPE   subject is any entity; value is a current role / lifecycle stage / membership label
ADMIT  text asserts a current role or lifecycle state
NOT FOR a future plan to acquire a role → intent
       a one-off action → interacted_with
VALUE  the noun naming the role/state — VERBATIM from input, never substituted`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 7,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tier',
    displayLabel: 'tier',
    description: `TYPE   subject is a customer/account; value is a segmentation tier label
ADMIT  text assigns a segmentation tier
NOT FOR a generic state → status
VALUE  the tier-label span from input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 30,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'address',
    displayLabel: 'address',
    description: `TYPE   subject is a person/org; value is a physical location
ADMIT  text states where the subject is, lives, is based, is located,
       or moved from/to as a place of residence/operation
NOT FOR a one-off visit → interacted_with
       a brand's target market → target_audience_segment
VALUE  the place-name or address span from the input`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 90,
    piiClass: 'sensitive',
    requiresScope: 'brain:read_pii',
    status: 'active',
    createdBy: 'system',
  },

  // ── BEHAVIORAL history (append-only, decay-weighted) ─────────────────
  {
    predicateId: 'preference',
    displayLabel: 'preference',
    description: `TYPE   subject is a person/customer; value is a thing/style/category preferred or disliked
ADMIT  text asserts a STABLE like / dislike / favourite (ongoing taste)
NOT FOR a forward-looking plan → intent
       a one-off action → interacted_with
       a complaint → complained_about
VALUE  ONLY the noun phrase naming the preferred thing — strip the verb`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'intent',
    displayLabel: 'intent',
    description: `TYPE   subject is a person/customer; value is a forward-looking plan, wish, or need
ADMIT  text asserts a future-tense plan, wish, or stated need
NOT FOR a stable taste → preference
       a completed action → interacted_with
       a current role → status
VALUE  the noun phrase or verb-phrase naming the planned thing or goal`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 60,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'complained_about',
    displayLabel: 'complained about',
    description: `TYPE   subject is a person/customer; value is the subject of a complaint
ADMIT  text reports a complaint, dissatisfaction, or problem report
NOT FOR a generic mention without negative sentiment → interacted_with
VALUE  the noun phrase naming the thing/topic complained about`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'text',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'interacted_with',
    displayLabel: 'interacted with',
    description: `TYPE   subject is a person/customer; value is a thing they touched
ADMIT  text states a one-off generic interaction (booked, viewed,
       contacted, attended, purchased, downloaded) without complaint,
       not as a long-term preference, not as a future plan
VALUE  the noun phrase naming the thing interacted with`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 30,
    piiClass: 'behavioral',
    status: 'active',
    createdBy: 'system',
  },

  // ── CONTENT-DOMAIN (singleton brand voice + multi-valued editorial) ──
  {
    predicateId: 'brand_voice',
    displayLabel: 'brand voice',
    description: `TYPE   subject is a brand; value is how it sounds (≤500 chars)
ADMIT  text describes the brand's voice style holistically
VALUE  the full style description as one fact (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'brand_archetype',
    displayLabel: 'brand archetype',
    description: `TYPE   subject is a brand; value is a Jungian archetype label
ADMIT  text labels the brand with an archetype (Hero/Sage/Outlaw/Explorer/
       Magician/Lover/Jester/Caregiver/Creator/Ruler/Innocent/Everyman)
VALUE  the archetype label span`,
    datatype: 'enum',
    semantics: 'single_active',
    decayHalfLifeDays: null,
    piiClass: 'none',
    allowedValues: [
      'Hero',
      'Sage',
      'Outlaw',
      'Explorer',
      'Magician',
      'Lover',
      'Jester',
      'Caregiver',
      'Creator',
      'Ruler',
      'Innocent',
      'Everyman',
    ],
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tone_of_voice',
    displayLabel: 'tone of voice',
    description: `TYPE   subject is a brand; value is style attributes (≤500 chars)
ADMIT  text describes tonality / style descriptors
VALUE  the descriptor span (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'product_description',
    displayLabel: 'product description',
    description: `TYPE   subject is a product/brand; value is a short product summary (≤1000 chars)
ADMIT  text describes what the product IS
VALUE  the description span (singleton — most recent wins)`,
    datatype: 'string',
    semantics: 'single_active',
    decayHalfLifeDays: 180,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'target_audience_segment',
    displayLabel: 'target audience segment',
    description: `TYPE   subject is a brand; value is one segment description
ADMIT  text identifies an audience segment the brand targets
VALUE  one segment per fact (multi-valued — each distinct segment is its own fact)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'content_guideline',
    displayLabel: 'content guideline',
    description: `TYPE   subject is a brand; value is one editorial rule
ADMIT  text states an editorial guideline
VALUE  one rule per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 365,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'tension_point',
    displayLabel: 'tension point',
    description: `TYPE   subject is a brand; value is one customer pain or contradiction
ADMIT  text identifies an audience pain the content addresses
VALUE  one tension per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 90,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'reference_example',
    displayLabel: 'reference example',
    description: `TYPE   subject is a brand; value is one URL or exemplar quote
ADMIT  text references a piece of content as an exemplar
VALUE  one URL/quote per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'narrative_pillar',
    displayLabel: 'narrative pillar',
    description: `TYPE   subject is a brand; value is one recurring theme
ADMIT  text identifies a theme the brand returns to
VALUE  one theme per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: 365,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
  {
    predicateId: 'forbidden_pattern',
    displayLabel: 'forbidden pattern',
    description: `TYPE   subject is a brand; value is one anti-pattern
ADMIT  text states something the brand must NOT do/say
VALUE  one anti-pattern per fact (multi-valued)`,
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
    createdBy: 'system',
  },
];

