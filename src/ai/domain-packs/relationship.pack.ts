import type { DomainPackManifest } from './manifest';

/**
 * Relationship pack. DISTRIBUTABLE (installed per-tenant from
 * `packs/relationship.pack.json`, NOT in BUILTIN_PACKS) — for a tenant
 * whose agents keep a relationship with the people they serve: a coach, a
 * concierge, a tutor (docs/roadmap/relationship-layer-2026-10.md §2.1).
 *
 * The vocabulary of a relationship that is not a profile: what was
 * promised and to whom, the topics left open, what the person said helped
 * and what did not, how they want to be spoken to, and what they said
 * about their own state — with the shelf life that state has. Boundaries
 * ("never bring up weight") are NOT here: they are the core `instruction`
 * predicate on the person's own entity, which serving already reads by
 * name and trust circles share out of a circle by default (§3.8).
 *
 * Read back by the `relationship_context` MCP tool.
 *
 * Bump `version` to update.
 */
export const RELATIONSHIP_PACK: DomainPackManifest = {
  id: 'relationship',
  version: '0.1.0',
  description:
    'Relationship memory — commitments and who they were made to, open threads, what helped and what did not, tone preferences and self-reported state with its shelf life; read back by relationship_context.',
  predicates: [
    {
      localId: 'commitment',
      displayLabel: 'commitment',
      description: `TYPE   subject is whoever promised (a person, an agent, a specialist); value is what they will do and for whom
ADMIT  a speaker commits to a later action — "I'll ask you on Sunday how the dinner went",
       "we agreed: a 15-minute walk after lunch, three times a week" — said by the one who commits
VALUE  the action and the person it is for ("ask Ana how her mother's birthday dinner went");
       when the turn names WHEN, give it as expectedEnd`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 30,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'open_thread',
      displayLabel: 'open thread',
      description: `TYPE   subject is the person; value is a topic they want to come back to
ADMIT  the person says they want to talk about something later — "depois quero conversar sobre
       os doces do escritório", "remind me to tell you about the trip"
VALUE  the topic ("how to deal with sweets at the office")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 30,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'helped',
      displayLabel: 'helped',
      description: `TYPE   subject is the person; value is an approach or action that, IN THEIR OWN WORDS, worked for them
ADMIT  the person says something worked or helped — "leaving washed fruit in the fridge worked
       really well". Never the agent's opinion of what helped
VALUE  the approach, short ("washed fruit in the fridge")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'did_not_help',
      displayLabel: 'did not help',
      description: `TYPE   subject is the person; value is an approach that, IN THEIR OWN WORDS, did not work for them
ADMIT  the person says something did not work or made it worse — "the weekly goal list didn't
       work for me, it made me feel guilty"
VALUE  the approach and, when given, why ("the weekly goal list — made her feel guilty")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'tone_preference',
      displayLabel: 'tone preference',
      description: `TYPE   subject is the person; value is how they want to be spoken to
ADMIT  the person says how they like to be addressed — "just tell me straight", "please keep it short"
VALUE  the preference ("direct, short messages")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'stated_affect',
      displayLabel: 'stated affect',
      description: `TYPE   subject is the person; value is how THEY SAY they feel
ADMIT  the person states their own state — "I'm exhausted this week", "woke up excited today".
       Never another speaker's guess about them
VALUE  the state as said ("exhausted, sleeping about five hours a night"); give expectedEnd for how
       long it holds when the turn says ("this week") — a mood without a span holds about a day`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: 7,
      piiClass: 'sensitive',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Apply this profile to conversations between a person and someone who helps
them — a coach, an assistant, a specialist. Prefer the relationship__* predicates:
a promise to do something later → relationship__commitment on WHOEVER PROMISED
(the coach's "I'll ask you tomorrow" is the coach's commitment; an agreement from a
session is the commitment of both who agreed), with expectedEnd when the turn says
when; a topic the person wants to return to → relationship__open_thread; what the
person says worked or did not → relationship__helped / relationship__did_not_help;
how they want to be spoken to → relationship__tone_preference; what they say about
their OWN state → relationship__stated_affect with expectedEnd. A rule about how to
treat the person ("never talk to me about weight") stays the core instruction
predicate on the person. Another speaker's guess about the person is never any of
these.`,
    fewShot: [
      // From another domain than any eval corpus — a tutor — so no battery
      // teaches itself to the extractor.
      {
        text: "[tutor] Deal — on Friday I'll send you three listening exercises.",
        note: "entity 'Tutor' → relationship__commitment='send Marco three listening exercises', expectedEnd = Friday.",
      },
      {
        text: '[Marco] Shadowing the podcast really helped; the flashcards did nothing for me.',
        note: "entity 'Marco' → relationship__helped='shadowing the podcast', relationship__did_not_help='flashcards'.",
      },
      {
        text: "[Marco] I'm wiped out until the exams are over.",
        note: "entity 'Marco' → relationship__stated_affect='wiped out', expectedEnd = end of the exams.",
      },
    ],
  },
};
