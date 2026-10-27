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
  version: '0.2.0',
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
    // The hypothesis lifecycle (relationship layer §1.1): a guess about the
    // person is never a fact about them (the core R5 rule) — it is a record
    // that it was PUT to them, and only their answer closes it.
    {
      localId: 'hypothesis',
      displayLabel: 'open hypothesis',
      description: `TYPE   subject is the person; value is a guess about them that someone PUT TO THEM and they have not answered
ADMIT  a counterpart asks or suggests something about the person, to the person — "could it be that you
       snack more after long meetings?", "I think you're anxious about work, right?" — and the person
       does not confirm or reject it in this conversation
VALUE  the guess and who made it ("coach: anxious about work"). Never a fact about the person`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 30,
      piiClass: 'sensitive',
      status: 'active',
    },
    {
      localId: 'hypothesis_confirmed',
      displayLabel: 'confirmed hypothesis',
      description: `TYPE   subject is the person; value is a guess put to them that THEY confirmed
ADMIT  the person agrees with a guess put to them — "yes, that's exactly it"
VALUE  the guess as confirmed ("coach: snacks more after long meetings"); what the person said in their own
       words is extracted as its own fact as well`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'sensitive',
      status: 'active',
    },
    {
      localId: 'hypothesis_rejected',
      displayLabel: 'rejected hypothesis',
      description: `TYPE   subject is the person; value is a guess put to them that THEY rejected
ADMIT  the person says a guess put to them is wrong — "no, I don't think that's it"
VALUE  the rejected guess ("coach: snacks more after long meetings") — so nobody puts it to them again;
       never stated as true about them`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
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
predicate on the person. Another speaker's guess about the person is never a fact
about them: when it is PUT TO the person, record it — answered in the conversation,
as relationship__hypothesis_confirmed or relationship__hypothesis_rejected; left
unanswered (a shrug, a change of subject), as relationship__hypothesis. When the
answer comes in a later conversation and the open hypothesis is a KNOWN FACT, the
outcome lists it in supersedes.`,
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
      {
        text: "[tutor] Maybe the grammar drills bore you? [Marco] No, it's the hour — I'm tired by nine.",
        note: "entity 'Marco' → relationship__hypothesis_rejected='tutor: the grammar drills bore him'; and Marco's own words as their own fact (tired by nine in the evening).",
      },
      {
        text: "[tutor] I think you're nervous about the oral exam? [Marco] Whatever. Can we do vocabulary?",
        note: "entity 'Marco' → relationship__hypothesis='tutor: nervous about the oral exam' — unanswered, so open; nothing about Marco being nervous.",
      },
    ],
  },
  // Tutor-domain too, for the same reason as the few-shot.
  evalFixtures: [
    {
      id: 'commitment',
      description: "a counterpart's promise is the counterpart's commitment",
      text: "[tutor] On Friday I'll send you three listening exercises.",
      expect: { facts: [{ predicate: 'commitment', objectIncludes: 'listening' }] },
    },
    {
      id: 'helped',
      description: 'what the person says worked',
      text: '[Marco] Shadowing the podcast really helped me.',
      expect: { facts: [{ predicate: 'helped', objectIncludes: 'shadowing' }] },
    },
    {
      id: 'tone',
      description: 'how the person wants to be spoken to',
      text: '[Marco] Please keep your feedback short and blunt.',
      expect: { facts: [{ predicate: 'tone_preference', objectIncludes: 'short' }] },
    },
    {
      id: 'hypothesis-rejected',
      description: 'a guess the person rejects is recorded as rejected, never as true',
      text: "[tutor] Maybe the grammar drills bore you?\n[Marco] No, that's not it at all.",
      expect: { facts: [{ predicate: 'hypothesis_rejected', objectIncludes: 'grammar' }] },
    },
  ],
};
