import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: persona / personal user memory. DISTRIBUTABLE
 * (installed per-tenant from `packs/persona.pack.json`, NOT in
 * BUILTIN_PACKS). Models the persistent memory of an END USER — who they
 * are, what they've lived through, what they like/dislike, who matters to
 * them, and what they do professionally — for assistants that maintain a
 * long-running relationship with a specific person.
 *
 * Scope decisions (six Synthius-Mem cognitive domains → our model):
 *  - Biography identity (name / dob / address / email / phone) stays in
 *    CORE — those predicates already exist with the right piiClass +
 *    requiresScope. The pack adds only `education` and `health_condition`.
 *  - Stable likes route to CORE `preference` (append_only, behavioral) —
 *    NOT duplicated here; declaring `persona__preference` would create an
 *    extractor routing collision. The pack adds `dislike` for the
 *    negative-polarity complement.
 *  - Social relationships between people stay `knowledge_edge` (free-form
 *    `kind`) — the extractionProfile names the recommended kinds
 *    (family_of / friend_of / colleague_of). The pack's predicates
 *    (`relationship_role`, `closeness`) attach to the CONTACT entity.
 *  - Episodic experiences carry emotional valence + intensity LEXICALLY
 *    in the verbatim value ("thrilled about finishing the marathon") —
 *    numeric valence is out of the verbatim-string fact model.
 *  - Psychometrics (Big Five etc. numeric framework scores with evidence
 *    quotes) is DEFERRED to v2: numeric scores + confidence need a JSON
 *    value convention and eval coverage this pack doesn't ship yet.
 *
 * Persona facts are per-user memory: ingest under a user-bound token (or
 * pass `userId`) so migration 0055's fail-closed read fence scopes them.
 * Bump `version` to update.
 */
export const PERSONA_PACK: DomainPackManifest = {
  id: 'persona',
  version: '0.1.0',
  description:
    'Personal user memory ontology — education, health basics, life events, emotions, dislikes, social circle, and work history of an end user, with a domain extraction profile. Per-user scoped.',
  predicates: [
    {
      localId: 'education',
      displayLabel: 'education',
      description: `TYPE   subject is a person; value is an educational credential/history
ADMIT  text states a degree, school, or field studied ("PhD in
       neuroscience at UCL", "studied law at Bologna")
NOT FOR generic learning intent (route to core intent)
VALUE  one credential per fact, verbatim ("PhD in neuroscience, UCL")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'health_condition',
      displayLabel: 'health condition',
      description: `TYPE   subject is a person; value is a stated health condition/basic
ADMIT  text EXPLICITLY states a condition the person has ("has type-2
       diabetes", "allergic to penicillin")
NOT FOR inferred, hypothetical, or third-party health facts — extract
       ONLY conditions the person states about themselves
VALUE  the condition, verbatim ("type-2 diabetes")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'sensitive',
      requiresScope: 'brain:read_pii',
      status: 'active',
    },
    {
      localId: 'life_event',
      displayLabel: 'life event',
      description: `TYPE   subject is a person; value is a significant life event
ADMIT  text reports a life episode ("got married in 2019", "moved to
       Berlin", "ran my first marathon last spring")
VALUE  one event per fact, verbatim, KEEPING any date words ("ran my
       first marathon last spring")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 365,
      piiClass: 'behavioral',
      status: 'active',
    },
    {
      localId: 'felt',
      displayLabel: 'felt',
      description: `TYPE   subject is a person; value is an emotion about a thing/event
ADMIT  text reports how the person felt about something ("was thrilled
       about the new job", "nervous before the exam")
VALUE  the emotion + its object, EMOTION WORD VERBATIM ("thrilled about
       the new job" — not "happy")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 180,
      piiClass: 'behavioral',
      status: 'active',
    },
    {
      localId: 'dislike',
      displayLabel: 'dislike',
      description: `TYPE   subject is a person; value is a thing/style/category disliked
ADMIT  text states a NEGATIVE preference ("hates cilantro", "can't
       stand open-plan offices")
NOT FOR positive preferences — route likes to core preference
VALUE  the disliked thing, verbatim ("cilantro")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 90,
      piiClass: 'behavioral',
      status: 'active',
    },
    {
      localId: 'relationship_role',
      displayLabel: 'relationship role',
      description: `TYPE   subject is a CONTACT (a person in the user's circle); value is
       their relationship role to the user
ADMIT  text names how a contact relates ("my sister Maria", "Tom, my
       college roommate")
VALUE  the role, verbatim ("sister", "college roommate"). Also emit a
       knowledge_edge from the contact to the user (family_of /
       friend_of / colleague_of).`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'behavioral',
      status: 'active',
    },
    {
      localId: 'closeness',
      displayLabel: 'closeness',
      description: `TYPE   subject is a CONTACT; value is how close they are to the user
ADMIT  text signals closeness ("we're very close", "a distant cousin")
VALUE  one of: close, moderate, distant`,
      datatype: 'enum',
      semantics: 'single_active',
      decayHalfLifeDays: 180,
      piiClass: 'behavioral',
      allowedValues: ['close', 'moderate', 'distant'],
      status: 'active',
    },
    {
      localId: 'occupation',
      displayLabel: 'occupation',
      description: `TYPE   subject is a person; value is their current role/occupation
ADMIT  text states what they do ("works as a data scientist", "I'm a
       nurse")
VALUE  the role, verbatim ("data scientist")`,
      datatype: 'string',
      semantics: 'bitemporal',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'employer',
      displayLabel: 'employer',
      description: `TYPE   subject is a person; value is their employer/organization
ADMIT  text names where they work ("at Acme", "joined Google in 2021")
VALUE  the organization, verbatim ("Google")`,
      datatype: 'string',
      semantics: 'bitemporal',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'skill',
      displayLabel: 'skill',
      description: `TYPE   subject is a person; value is a skill/competency they have
ADMIT  text states a skill the person has ("fluent in Japanese", "good
       at woodworking")
VALUE  one skill per fact, verbatim ("fluent in Japanese")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Persona inputs describe ONE end user and the people in their circle.
The user is the SUBJECT for biography, episodes, and work facts. Contacts are
their OWN entities carrying persona__relationship_role and persona__closeness,
plus a knowledge_edge to the user (family_of / friend_of / colleague_of).

Route to CORE predicates, NOT pack predicates:
- identity → core name / dob / address / email / phone
- stable LIKES / positive preferences → core preference
- plans / wants / goals → core intent

Use persona__* for: education (persona__education), stated health conditions
(persona__health_condition — extract ONLY what the person explicitly states,
never infer), life events (persona__life_event), emotions (persona__felt),
NEGATIVE preferences (persona__dislike), a contact's role/closeness
(persona__relationship_role / persona__closeness), and work
(persona__occupation / persona__employer / persona__skill).

Copy emotions and events VERBATIM — "thrilled" not "happy", "ran my first
marathon last spring" not "did exercise".`,
    fewShot: [
      {
        text: "I did my PhD in neuroscience at UCL, and I've worked as a data scientist at Acme since 2021.",
        note: "subject=the user → persona__education='PhD in neuroscience at UCL', persona__occupation='data scientist', persona__employer='Acme'.",
      },
      {
        text: 'I was absolutely thrilled when I finished my first marathon last spring.',
        note: "→ persona__life_event='finished my first marathon last spring', persona__felt='thrilled about finishing my first marathon'.",
      },
      {
        text: 'I love Italian food but I honestly cannot stand cilantro.',
        note: "positive like → core preference='Italian food'; negative → persona__dislike='cilantro'. Do NOT emit persona__preference (there is none).",
      },
      {
        text: "My sister Maria and I are very close — she's a nurse in Lisbon.",
        note: "contact 'Maria' → persona__relationship_role='sister', persona__closeness='close', persona__occupation='nurse'; emit a knowledge_edge Maria→user kind='family_of'.",
      },
    ],
  },
  evalFixtures: [
    {
      id: 'education',
      description: 'an education credential is extracted',
      text: 'I studied law at the University of Bologna.',
      expect: { facts: [{ predicate: 'education', objectIncludes: 'law' }] },
    },
    {
      id: 'life-event',
      description: 'a life event keeps its date words',
      text: 'We got married in 2019.',
      expect: { facts: [{ predicate: 'life_event', objectIncludes: 'married' }] },
    },
    {
      id: 'felt',
      description: 'the emotion word is captured verbatim',
      text: 'I was thrilled about starting the new job.',
      expect: { facts: [{ predicate: 'felt', objectIncludes: 'thrilled' }] },
    },
    {
      id: 'dislike',
      description: 'a negative preference routes to dislike',
      text: "I really can't stand cilantro.",
      expect: { facts: [{ predicate: 'dislike', objectIncludes: 'cilantro' }] },
    },
    {
      id: 'occupation',
      description: 'the current occupation is captured',
      text: 'I work as a data scientist.',
      expect: { facts: [{ predicate: 'occupation', objectIncludes: 'data scientist' }] },
    },
    {
      id: 'skill',
      description: 'a skill is captured verbatim',
      text: 'I am fluent in Japanese.',
      expect: { facts: [{ predicate: 'skill', objectIncludes: 'Japanese' }] },
    },
    {
      id: 'health',
      description: 'a stated health condition is captured (sensitive)',
      text: 'I have type-2 diabetes.',
      expect: {
        facts: [{ predicate: 'health_condition', objectIncludes: 'diabetes' }],
      },
    },
  ],
};
