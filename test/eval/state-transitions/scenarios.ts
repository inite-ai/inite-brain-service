/**
 * The scenario battery: 12 mutable-world-state scenarios for ONE user
 * ("Sasha", userId stev-agent). Each scenario owns its entity/object so
 * scenarios cannot cross-contaminate, and declares 2-4 typed checks the
 * runner executes after the builds (see types.ts for check semantics).
 *
 * Scoreability rules applied throughout (the sibling's D1 forbid-lesson
 * plus the decline-regex interplay):
 *
 *  - prefer expectAnyOf on the CURRENT-state marker over forbidAnyOf on
 *    the old value — "currently X, previously Y" is an honest answer;
 *  - forbid only where naming the old value at all is an unambiguous
 *    stale leak, and never with phrases a NEGATED honest answer would
 *    contain ("you haven't sold it yet" contains 'sold it');
 *  - never use bare 'no' / 'do not' / "don't" as expect markers: decline
 *    answers contain them ("I do not have information…"), and 'now'
 *    contains 'no'. Negative states are asserted through markers that
 *    only occur in substantive answers: 'sold', 'returned', 'no longer',
 *    'not own';
 *  - every provenance fragment appears VERBATIM in exactly one seeded
 *    turn, under the 600-char provenance text cap.
 *
 * Belief-check subjects accept any self-referring key ('Sasha' | 'user'
 * | 'speaker') because the (subject, field) key is enrichment-authored
 * free text; the discriminating half of those checks is field + value.
 * The third-party scenario (s09) pins the subject to 'Boris' on purpose
 * — subject attribution IS what it measures.
 */
import type { Scenario, ScenarioTurn } from './types';

/** The vertical every scenario write attributes itself to. */
export const CORPUS_VERTICAL = 'personal';

/** The agent's own entity — first-person turns resolve to it. */
export const SPEAKER = {
  vertical: CORPUS_VERTICAL,
  id: 'agent-sasha',
  role: 'speaker',
  name: 'Sasha',
} as const;

/** Anchor entity for the third-party scenario (s09). */
export const BORIS_REF = { vertical: CORPUS_VERTICAL, id: 'brother-boris' } as const;

/** Any self-referring belief subject counts (enrichment-authored key). */
const SELF = ['Sasha', 'user', 'speaker'];

/** Timestamp of turn N (1-based) — 5 minutes apart within a session. */
const t = (startIso: string, turn: number): string =>
  new Date(Date.parse(startIso) + (turn - 1) * 5 * 60_000).toISOString();

const conv = (conversation: string, startIso: string, texts: string[]): ScenarioTurn[] =>
  texts.map((text, i) => ({ conversation, turn: i + 1, emittedAt: t(startIso, i + 1), text }));

export const SCENARIOS: Scenario[] = [
  // ── s01 — dispose: owned thing sold, current truth is "none" ──────
  {
    key: 's01',
    name: 'dispose',
    cls: 'dispose',
    intent:
      'Acquire then dispose. Current truth is a NEGATION (no bike); the belief must flip to a none-ish value with the Kawasaki as priorValue.',
    turns: [
      ...conv('s01a', '2026-08-03T10:00:00Z', [
        'Life log, 2026-08-03. Weekend update: there is a new vehicle in my life.',
        "I bought a Kawasaki Ninja on Saturday — it's registered to me.",
        'The Ninja lives in the garage; I plan to ride it to work on dry days.',
      ]),
      ...conv('s01b', '2026-08-10T17:00:00Z', [
        'Life log, 2026-08-10. The motorcycle experiment is over.',
        'I sold the Kawasaki today; no bike anymore.',
        'The buyer picked it up this evening and the registration transfer is done.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's01-serve',
        query: 'Do I own a motorcycle right now?',
        // Negative-state markers only occur in substantive answers; a
        // pure decline never contains them, and marker-first scoring
        // (scorers.ts) keeps the honest "you don't have a bike anymore"
        // from being misread as abstention. No forbid list: 'Kawasaki'
        // in the answer is honest history ("you sold the Kawasaki"),
        // and there is no scoreable "Ninja-as-yours" phrase to forbid.
        expectAnyOf: ['sold', 'no longer', 'do not own', "don't own", 'not own', 'no bike'],
      },
      {
        kind: 'belief',
        id: 's01-belief',
        subjectTokens: SELF,
        fieldTokens: ['bike', 'motorcycle', 'motorbike', 'vehicle'],
        valueMarkers: ['none', 'sold', 'no'],
        priorMarkers: ['Kawasaki', 'Ninja'],
        // minRevision is 1, not 2: when both scenes land in ONE promotion
        // batch, buildBeliefFold folds them to the final state directly —
        // rev=1 carrying value + priorValue. The value/prior pair is the
        // mechanical signal of a completed transition; the revision
        // counter only increments across separate promotion runs.
        minRevision: 1,
        // Baseline policy: this check RUNS and its fail is RECORDED —
        // that is the baseline the flags below are measured against.
        knownFailToday:
          '#135 SCENES_BELIEF_NEGATION_DELTAS — disposal ("no bike anymore") does not ' +
          'reliably emit a stateDelta today, so the belief stays at the acquisition revision',
      },
    ],
  },

  // ── s02 — replace: same field, new value ──────────────────────────
  {
    key: 's02',
    name: 'replace',
    cls: 'replace',
    intent:
      'Clean same-field replacement (laptop): current truth flips, the belief carries value+priorValue, and the timeline retains both stages.',
    turns: [
      ...conv('s02a', '2026-08-04T09:00:00Z', [
        'Work-setup log, 2026-08-04.',
        'My work laptop is a ThinkPad X1 Carbon; it is the machine I do everything on.',
      ]),
      ...conv('s02b', '2026-08-12T09:00:00Z', [
        'Work-setup log, 2026-08-12. Laptop swap day.',
        'I replaced my laptop today: my work laptop is now a MacBook Pro, and the ThinkPad went back to IT.',
        'Everything is migrated; the MacBook Pro is the only machine I work on now.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's02-serve',
        query: 'Which laptop do I use for work right now?',
        expectAnyOf: ['MacBook'],
        // Forbid IS justified here (unlike s08): the corpus states the
        // ThinkPad went back to IT and the MacBook is "the only machine"
        // — on a "right now" question any mention of the ThinkPad is a
        // stale leak, the exact D1 semantics of the sibling.
        forbidAnyOf: ['ThinkPad'],
      },
      {
        kind: 'belief',
        id: 's02-belief',
        subjectTokens: SELF,
        fieldTokens: ['laptop'],
        valueMarkers: ['MacBook'],
        priorMarkers: ['ThinkPad'],
        // rev=1 is legitimate for a one-batch promotion (see s01 note).
        minRevision: 1,
      },
      {
        kind: 'fact-history',
        id: 's02-history',
        searchQuery: 'work laptop',
        // Distinct values per stage — the easy case for object markers.
        stages: [['ThinkPad'], ['MacBook']],
      },
    ],
  },

  // ── s03 — re-acquire: A -> not-A -> A again ───────────────────────
  {
    key: 's03',
    name: 're-acquire',
    cls: 're-acquire',
    intent:
      'Membership toggles twice (join / quit / rejoin). Current truth is the SECOND join; all three stages must survive in history.',
    turns: [
      ...conv('s03a', '2026-08-02T18:00:00Z', [
        'Evening log, 2026-08-02.',
        'I joined the chess club today; sessions are on Mondays.',
      ]),
      ...conv('s03b', '2026-08-09T18:00:00Z', [
        'Evening log, 2026-08-09.',
        'I quit the chess club today; Mondays got too busy at work.',
      ]),
      ...conv('s03c', '2026-08-20T18:00:00Z', [
        'Evening log, 2026-08-20.',
        'I rejoined the chess club today — they moved sessions to Thursdays, so I am a member again.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's03-serve',
        query: 'Am I currently a member of the chess club?',
        // 'member' / 'rejoined' only occur when the final state is
        // served; a stale "you quit the chess club" answer contains
        // neither and fails on the expect side — no forbid needed
        // ('quit' would false-fail the honest "you quit, then rejoined").
        expectAnyOf: ['member', 'rejoined'],
      },
      {
        kind: 'fact-history',
        id: 's03-history',
        searchQuery: 'chess club',
        // Membership stages share one object ('chess club'), so markers
        // match predicate+object combined and stay broad — extraction
        // wording is LLM-chosen. Greedy subsequence matching keeps the
        // 'join' ⊂ 'rejoined' overlap from eating the wrong stage: each
        // stage scans only events after its predecessor's match.
        stages: [
          ['join', 'member'],
          ['quit', 'left', 'no longer', 'former'],
          ['rejoin', 'again', 'member'],
        ],
      },
    ],
  },

  // ── s04 — retro-dated: told late, effective earlier ───────────────
  {
    key: 's04',
    name: 'retro-dated',
    cls: 'retro-dated',
    intent:
      'A cancellation reported two weeks after the fact ("back on August 1st"). Current truth must be "cancelled" and the claim must unroll to the seeded turn.',
    turns: [
      ...conv('s04a', '2026-08-15T12:00:00Z', [
        'Subscriptions log, 2026-08-15. Going through my bank statement.',
        'Turns out I actually cancelled my Spotify subscription back on August 1st.',
        'So since the start of the month I have had no music subscription at all.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's04-serve',
        query: 'Do I have an active Spotify subscription?',
        // Both spellings; 'no longer' / 'no subscription' cover answers
        // that negate without the verb. Bare 'no' banned (see header).
        expectAnyOf: ['cancelled', 'canceled', 'no longer', 'no subscription'],
      },
      {
        kind: 'provenance',
        id: 's04-prov',
        searchQuery: 'Spotify subscription cancelled',
        episodeFragments: ['cancelled my Spotify'],
      },
    ],
  },

  // ── s05 — intention-not-action: state must NOT flip ───────────────
  {
    key: 's05',
    name: 'intention-not-action',
    cls: 'non-transition-guard',
    intent:
      'A voiced intention ("thinking about selling") is NOT a transition: ownership must still serve as current, while the intention is remembered as an intention.',
    turns: [
      ...conv('s05a', '2026-08-01T11:00:00Z', [
        'Hobby log, 2026-08-01.',
        'I own a drone — a DJI Mavic 3 I bought last spring; I fly it most weekends.',
      ]),
      ...conv('s05b', '2026-08-05T11:00:00Z', [
        'Hobby log, 2026-08-05.',
        "I'm thinking about selling my drone, maybe next month.",
        'No decision yet; I want to see what used Mavics go for first.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's05-serve-state',
        query: 'Do I still own a drone?',
        // 'still' passes "you're still thinking about selling your
        // drone" by design — it presupposes unchanged ownership. The
        // forbid list stays minimal: 'sold'/'sold it' would false-fail
        // the honest "you haven't sold it yet"; a wrong flipped answer
        // ("you sold the drone") already fails on the expect side.
        // 'owns' covers the third-person phrasing a strict-guardrails answer
        // legitimately uses ("Sasha owns a DJI Mavic 3 drone") — live run
        // stmtp6jzxd answered honestly and the old list missed it.
        expectAnyOf: [
          'yes',
          'you own',
          'owns',
          'still',
          'have a drone',
          'have the drone',
          'own the drone',
        ],
        forbidAnyOf: ['no longer own'],
      },
      {
        kind: 'serve',
        id: 's05-serve-intent',
        query: 'What are my plans for the drone?',
        // The other half of the guard: the intention itself must be
        // remembered ('sell' ⊂ 'selling'), not dropped as noise.
        expectAnyOf: ['sell'],
      },
    ],
  },

  // ── s06 — listed-not-sold: on the market is still owned ───────────
  {
    key: 's06',
    name: 'listed-not-sold',
    cls: 'non-transition-guard',
    intent:
      'Listing an apartment for sale is NOT a disposal: ownership must still serve as current.',
    turns: [
      ...conv('s06a', '2026-08-07T14:00:00Z', [
        'Property log, 2026-08-07.',
        'I listed my apartment in Riga for sale today.',
        'The listing went live in the afternoon; the agent expects the first viewings next week.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's06-serve',
        query: 'Do I currently own the Riga apartment?',
        // Scoped ownership markers ('you own', not bare 'own' — which
        // hides in 'unknown'/'owner'). The task-suggested forbid 'sold
        // it' was DROPPED: the honest "listed, but you haven't sold it
        // yet" contains it. 'no longer own' is kept — it only occurs in
        // a wrongly flipped answer.
        expectAnyOf: ['yes', 'you own', 'still own', 'listed', 'for sale', 'on the market'],
        forbidAnyOf: ['no longer own'],
      },
      {
        kind: 'provenance',
        id: 's06-prov',
        searchQuery: 'apartment Riga for sale',
        episodeFragments: ['listed my apartment in Riga'],
      },
    ],
  },

  // ── s07 — contradiction: two live sources disagree ────────────────
  {
    key: 's07',
    name: 'contradiction',
    cls: 'conflict',
    intent:
      'Two conversations assert different lease end dates. Honest serving names BOTH or abstains; silently picking one side is the failure.',
    turns: [
      ...conv('s07a', '2026-08-08T10:00:00Z', [
        'Office log, 2026-08-08.',
        'The office lease runs until December 2026. That is what our signed contract copy says.',
      ]),
      ...conv('s07b', '2026-08-14T10:00:00Z', [
        'Office log, 2026-08-14. Surprise from the building manager.',
        'Facilities says the office lease actually ends in September 2026.',
        'I have not reconciled the two dates yet; someone is wrong and I need the original lease.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's07-serve',
        query: 'When does the office lease end?',
        // classifyConflictAnswer semantics (sibling D6): both-sides or
        // abstained pass, one-sided fails. Month names are the sides —
        // unambiguous and phrasing-proof.
        conflictSides: { sideA: ['December'], sideB: ['September'] },
        knownFailToday:
          'CONFLICT_MENTION_FACT_SLOT — mention-path extraction resolves the slot to ' +
          'single_active semantics, whose resolver branch supersedes unconditionally and ' +
          'never forms the COMPETING pair, so serving picks one side; the flag (default ' +
          'off) promotes the slot to bitemporal margin doctrine',
      },
      {
        kind: 'provenance',
        id: 's07-prov',
        searchQuery: 'office lease end date',
        // Either side's seeded turn proves the claim unrolls verbatim.
        episodeFragments: ['ends in September 2026', 'runs until December 2026'],
      },
    ],
  },

  // ── s08 — field-drift: same state, differently named field ────────
  {
    key: 's08',
    name: 'field-drift',
    cls: 'field-drift',
    intent:
      'The same underlying field is worded differently across conversations ("home city" vs "place of residence"). Serving must still flip; the belief fold is the known gap.',
    turns: [
      ...conv('s08a', '2026-08-03T19:00:00Z', [
        'Relocation log, 2026-08-03.',
        'My home city is Lisbon now.',
      ]),
      ...conv('s08b', '2026-08-18T19:00:00Z', [
        'Relocation log, 2026-08-18. Another move, sooner than planned.',
        'Moved my place of residence to Porto this week.',
        'The Lisbon chapter is closed; from now on Porto is where I live.',
      ]),
    ],
    checks: [
      {
        kind: 'belief',
        id: 's08-belief',
        subjectTokens: SELF,
        fieldTokens: ['city', 'residence', 'home', 'location', 'lives'],
        valueMarkers: ['Porto'],
        priorMarkers: ['Lisbon'],
        // rev=1 is legitimate for a one-batch promotion (see s01 note).
        minRevision: 1,
        knownFailToday:
          '#135 SCENES_BELIEF_FIELD_FOLD — "home city" and "place of residence" fold into ' +
          'different free-text field keys, so no single belief carries value + priorValue',
      },
      {
        kind: 'serve',
        id: 's08-serve',
        query: 'Which city do I live in now?',
        expectAnyOf: ['Porto'],
        // "Lisbon-as-current" is not mechanically separable from the
        // honest "moved from Lisbon to Porto", so no forbid (D1
        // forbid-lesson): a wrong "Lisbon" answer already fails on the
        // missing 'Porto'.
      },
    ],
  },

  // ── s09 — third-party: state of someone who is not the speaker ────
  {
    key: 's09',
    name: 'third-party',
    cls: 'third-party',
    intent:
      "Boris's company car is acquired and returned. The transition must attach to BORIS — subject attribution is the point of the belief check.",
    turns: [
      ...conv('s09a', '2026-08-09T13:00:00Z', [
        'Family log, 2026-08-09.',
        'My brother Boris got a company car from his employer.',
      ]),
      ...conv('s09b', '2026-08-16T13:00:00Z', [
        'Family log, 2026-08-16.',
        'Boris returned the company car when he switched jobs.',
        'He starts at the new place on September 1st and will commute by train.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's09-serve',
        query: 'Does my brother Boris have a company car?',
        // 'not have' was rejected: the decline "I do not have
        // information about Boris" contains it (false pass). 'returned'
        // is seeded verbatim and only occurs in a substantive answer.
        expectAnyOf: ['returned', 'no longer', 'gave it back', 'not anymore'],
      },
      {
        kind: 'belief',
        id: 's09-belief',
        // Subject pinned to Boris — misattributing the car to Sasha
        // fails here even if serving happens to answer correctly.
        subjectTokens: ['Boris'],
        fieldTokens: ['car', 'vehicle'],
        // Deliberately lenient on value (either state counts): this
        // check measures third-party SUBJECT attribution, not the
        // negation flip — s01 already measures that and is the known
        // negation-delta baseline.
        valueMarkers: ['company car', 'returned', 'none', 'car'],
        minRevision: 1,
      },
    ],
  },

  // ── s10 — same-day: two transitions hours apart ───────────────────
  {
    key: 's10',
    name: 'same-day',
    cls: 'same-day',
    intent:
      'Acquire at 10:00, dispose at 18:00 the same day. Current truth is the evening state; history must order the two intra-day stages.',
    turns: [
      ...conv('s10a', '2026-08-11T10:00:00Z', [
        'Home-office log, 2026-08-11, morning.',
        'Signed up for the standing desk trial this morning.',
      ]),
      ...conv('s10b', '2026-08-11T18:00:00Z', [
        'Home-office log, 2026-08-11, evening. That did not last long.',
        'Returned the standing desk by evening — hurt my back.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's10-serve',
        query: 'Do I still have the standing desk?',
        expectAnyOf: ['returned', 'sent it back', 'no longer'],
      },
      {
        kind: 'fact-history',
        id: 's10-history',
        searchQuery: 'standing desk',
        // Hour-resolution ordering: both stages carry the same date and
        // differ only by time of day.
        stages: [
          ['signed up', 'sign up', 'trial', 'started'],
          ['returned', 'sent back', 'return'],
        ],
      },
    ],
  },

  // ── s11 — multi-object: one of two disposed, the other kept ───────
  {
    key: 's11',
    name: 'multi-object',
    cls: 'multi-object',
    intent:
      'Two cameras; one is sold. The kept object must serve as current and the sold one as gone — WITHOUT forbidding the sold name (the honest recap names it).',
    turns: [
      ...conv('s11a', '2026-08-06T15:00:00Z', [
        'Photography log, 2026-08-06.',
        'I keep two cameras: a Fuji X100 and a Canon R6.',
      ]),
      ...conv('s11b', '2026-08-19T15:00:00Z', [
        'Photography log, 2026-08-19. Gear cull.',
        'Sold the Canon R6; the Fuji stays.',
        'One camera is enough — the X100 covers everything I actually shoot.',
      ]),
    ],
    checks: [
      {
        kind: 'serve',
        id: 's11-serve-kept',
        query: 'Which cameras do I have now?',
        // forbidAnyOf ['Canon R6'] would be WRONG: the honest answer
        // "just the Fuji — you sold the Canon R6" names it. The Fuji
        // marker carries this check; the sold-object side is asserted
        // by the second, directly-scoped serve below.
        expectAnyOf: ['Fuji'],
      },
      {
        kind: 'serve',
        id: 's11-serve-sold',
        query: 'Do I still have the Canon R6?',
        // Bare 'no' banned ('now' contains 'no'); 'sold' is seeded
        // verbatim and unambiguous on this directly-scoped question.
        expectAnyOf: ['sold', 'no longer', 'not anymore'],
      },
    ],
  },

  // ── s12 — provenance of the transition itself (reuses s01 data) ───
  {
    key: 's12',
    name: 'provenance-of-transition',
    cls: 'provenance',
    intent:
      'Both endpoints of the s01 transition unroll to their seeded turns: the state flip is evidence-backed, not asserted.',
    turns: [], // deliberately empty — interrogates the s01 corpus
    checks: [
      {
        kind: 'provenance',
        id: 's12-prov-sold',
        searchQuery: 'Kawasaki motorcycle sold',
        episodeFragments: ['sold the Kawasaki'],
      },
      {
        kind: 'provenance',
        id: 's12-prov-bought',
        searchQuery: 'Kawasaki Ninja bought',
        episodeFragments: ['bought a Kawasaki Ninja'],
      },
    ],
  },
];

/** All mention turns across scenarios, sorted chronologically. */
export const ALL_TURNS: ScenarioTurn[] = SCENARIOS.flatMap((s) => s.turns).sort((a, b) =>
  a.emittedAt.localeCompare(b.emittedAt),
);
