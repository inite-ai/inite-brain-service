/**
 * Deterministic state-verb harvest lane (EXTRACTOR_STATE_VERB_HARVEST)
 * — sibling of the literal-harvest lane. Fixtures are the VERBATIM
 * corpus sentences from test/eval/state-transitions/scenarios.ts — the
 * turns whose transitions the closed-vocab LLM extraction measurably
 * dropped (battery fact-history 0/3 on 2 live runs).
 */
import {
  STATE_CHANGE_PREDICATE,
  STATE_VERB_HARVEST_CAP,
  STATE_VERB_HARVEST_CONFIDENCE,
  harvestStateVerbs,
} from '../src/ai/extractor-internals/state-verb-harvest';
import { resolveSpeakerEntityIndex } from '../src/ai/extractor-internals/literal-harvest';
import { isGroundedSpan, normalizeForGrounding } from '../src/ai/extractor-internals/grounding';
import type { ExtractedEntity, ExtractedFact } from '../src/ai/extractor-internals/types';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';

const ent = (name: string, type: ExtractedEntity['type'] = 'staff'): ExtractedEntity => ({
  name,
  type,
});

/** Positional convenience over the options-object production signature. */
const harvest = (
  trimmed: string,
  entities: ExtractedEntity[],
  speakerEntityIndex: number | null,
  existingFacts: ExtractedFact[] = [],
): ExtractedFact[] => harvestStateVerbs({ trimmed, entities, speakerEntityIndex, existingFacts });

// ── Verbatim corpus fixtures (test/eval/state-transitions/scenarios.ts) ──
const S01_BOUGHT_TURN = "I bought a Kawasaki Ninja on Saturday — it's registered to me.";
const S01_SOLD_TURN = 'I sold the Kawasaki today; no bike anymore.';
const S02_SWITCH_TURN =
  'I replaced my laptop today: my work laptop is now a MacBook Pro, and the ThinkPad went back to IT.';
const S03_JOIN_TURN = 'I joined the chess club today; sessions are on Mondays.';
const S03_QUIT_TURN = 'I quit the chess club today; Mondays got too busy at work.';
const S03_REJOIN_TURN =
  'I rejoined the chess club today — they moved sessions to Thursdays, so I am a member again.';
const S04_CANCEL_TURN =
  'Turns out I actually cancelled my Spotify subscription back on August 1st.';
const S05_INTENT_TURN = "I'm thinking about selling my drone, maybe next month.";
const S06_LISTED_TURN = 'I listed my apartment in Riga for sale today.';
const S09_RETURN_TURN = 'Boris returned the company car when he switched jobs.';
const S10_SIGNUP_TURN = 'Signed up for the standing desk trial this morning.';
const S10_RETURN_TURN = 'Returned the standing desk by evening — hurt my back.';
const S11_SOLD_TURN = 'Sold the Canon R6; the Fuji stays.';

const SASHA = [ent('Sasha')];

describe('harvestStateVerbs — positive table (verbatim battery turns)', () => {
  const TABLE: Array<[string, string, string]> = [
    // [label, turn, expected verbatim span]
    ['s03 join', S03_JOIN_TURN, 'joined the chess club today'],
    ['s03 quit', S03_QUIT_TURN, 'quit the chess club today'],
    ['s03 rejoin', S03_REJOIN_TURN, 'rejoined the chess club today'],
    ['s10 signup', S10_SIGNUP_TURN, 'Signed up for the standing desk trial this morning'],
    ['s10 return', S10_RETURN_TURN, 'Returned the standing desk by evening'],
    ['s02 switch', S02_SWITCH_TURN, 'replaced my laptop today'],
    ['s11 sold', S11_SOLD_TURN, 'Sold the Canon R6'],
    ['s01 bought', S01_BOUGHT_TURN, 'bought a Kawasaki Ninja on Saturday'],
    ['s01 sold', S01_SOLD_TURN, 'sold the Kawasaki today'],
    [
      's04 retro-dated cancel',
      S04_CANCEL_TURN,
      'cancelled my Spotify subscription back on August 1st',
    ],
  ];

  it.each(TABLE)('%s → exactly one state_change, span pinned', (_label, turn, span) => {
    const facts = harvest(turn, SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe(STATE_CHANGE_PREDICATE);
    expect(facts[0]!.object).toBe(span);
    expect(facts[0]!.valueSpan).toBe(span);
    expect(facts[0]!.entityIndex).toBe(0);
    expect(facts[0]!.confidence).toBe(STATE_VERB_HARVEST_CONFIDENCE);
  });

  it('s03 quit turn: "Mondays got too busy" does NOT co-harvest (got object gate)', () => {
    // The single fact asserted above is the whole point: `got` only
    // fires on a determiner-opening object ("got a company car"),
    // never on an adjectival result ("got too busy at work").
    const facts = harvest(S03_QUIT_TURN, SASHA, 0);
    expect(facts.map((f) => f.object)).toEqual(['quit the chess club today']);
  });

  it('s09 third-party turn binds to Boris — a PERSON named in the sentence wins', () => {
    const entities = [ent('Boris', 'customer'), ent('Sasha')];
    const facts = harvest(S09_RETURN_TURN, entities, resolveSpeakerEntityIndex(entities, 'Sasha'));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.object).toBe('returned the company car');
    expect(facts[0]!.entityIndex).toBe(0);
  });

  it('object entities never steal the binding — state holder is the speaker', () => {
    // Live-run regression (stmtp52jfw): "returned the standing desk" bound
    // to the "standing desk" asset entity, scattering the two stages of a
    // transition across different timelines. A transition is a fact about
    // the state HOLDER: non-person entities named in the sentence are
    // skipped and the fact lands on the speaker.
    const entities = [ent('standing desk', 'asset'), ent('Sasha')];
    const facts = harvest(
      'Returned the standing desk by evening.',
      entities,
      resolveSpeakerEntityIndex(entities, 'Sasha'),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.entityIndex).toBe(1);
  });
});

describe('harvestStateVerbs — negative table (guards + lexicon holes)', () => {
  const NOTHING: Array<[string, string]> = [
    // Gerund by construction: 'selling' is not a completed form, and
    // 'thinking about' is a guard besides (battery s05 must NOT flip).
    ['s05 intention turn', S05_INTENT_TURN],
    // 'listed' is deliberately NOT in the lexicon: listing something
    // for sale is not a possession transition (battery s06).
    ['s06 listed-not-sold turn', S06_LISTED_TURN],
    ['negated completion', "I haven't sold the bike"],
    ['future tense', 'I will quit next month'],
    [
      'hypothetical (guard on might; "leave" is not a completed form)',
      'we discussed whether he might leave',
    ],
    ['never + verb', 'I never returned the standing desk'],
    ['intention idiom', 'I am planning to quit the gym'],
    ['plain prose without lexicon verbs', 'Priya owns the Meridian integration on our side.'],
    // A bare verb with no object noun phrase harvests nothing.
    [
      'passive/bare verb, empty NP',
      'The Lisbon chapter is closed; from now on Porto is where I live.',
    ],
  ];
  it.each(NOTHING)('%s → no facts', (_label, text) => {
    expect(harvest(text, [ent('Sasha'), ent('Priya')], 0)).toEqual([]);
  });
});

describe('harvestStateVerbs — invariants', () => {
  const POSITIVES = [
    S01_BOUGHT_TURN,
    S01_SOLD_TURN,
    S02_SWITCH_TURN,
    S03_JOIN_TURN,
    S03_QUIT_TURN,
    S03_REJOIN_TURN,
    S04_CANCEL_TURN,
    S09_RETURN_TURN,
    S10_SIGNUP_TURN,
    S10_RETURN_TURN,
    S11_SOLD_TURN,
  ];

  it('every harvested valueSpan passes the grounding gate by construction', () => {
    let checked = 0;
    for (const text of POSITIVES) {
      for (const f of harvest(text, SASHA, 0)) {
        expect(
          isGroundedSpan(normalizeForGrounding(text), normalizeForGrounding(f.valueSpan!)),
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(POSITIVES.length);
  });

  it('dedup: a pre-existing same-(entity, predicate, object) fact suppresses the harvest', () => {
    const existing: ExtractedFact[] = [
      {
        entityIndex: 0,
        predicate: STATE_CHANGE_PREDICATE,
        object: 'sold the Kawasaki today',
        confidence: 0.7,
        valueSpan: 'sold the Kawasaki today',
      },
    ];
    expect(harvest(S01_SOLD_TURN, SASHA, 0, existing)).toEqual([]);
  });

  it('cap: pathological input with 20 transitions yields at most 6 facts', () => {
    const pathological =
      'I ' + Array.from({ length: 20 }, (_, i) => `joined club${i}`).join(', ') + '.';
    const facts = harvest(pathological, SASHA, 0);
    expect(facts).toHaveLength(STATE_VERB_HARVEST_CAP);
  });

  it('no grounded actor anywhere → nothing is emitted', () => {
    expect(harvest(S01_SOLD_TURN, [ent('unrelated-name')], null)).toEqual([]);
    expect(harvest(S01_SOLD_TURN, [], null)).toEqual([]);
  });
});

// ── Coding-domain verbs (code-memory dogfood, additions-only) ────────
// The consumer-life lexicon harvested nothing from a coding agent's
// narration; these pin the added CODING_VERBS entries — completed
// forms, adjacent phrasal "rolled back", guards intact, and the
// holder-binding / passive-subject behaviour DOCUMENTED as-is.
describe('harvestStateVerbs — coding-domain verbs', () => {
  const CODING_TABLE: Array<[string, string, string]> = [
    // [label, turn, expected verbatim span]
    [
      'merged',
      'We merged PR #431 this morning; CI went green after the rerun.',
      'merged PR #431 this morning',
    ],
    [
      'reverted',
      'I reverted the queue-relay cutover today.',
      'reverted the queue-relay cutover today',
    ],
    [
      'enabled',
      'We enabled EXTRACTOR_STATE_VERB_HARVEST in prod.',
      'enabled EXTRACTOR_STATE_VERB_HARVEST in prod',
    ],
    [
      'disabled',
      'We disabled the flaky retry sweep on staging.',
      'disabled the flaky retry sweep on staging',
    ],
    [
      'deployed',
      'Deployed the billing service to eu-west yesterday.',
      'Deployed the billing service to eu-west yesterday',
    ],
    [
      'released',
      'We released version 24 of the ingest worker.',
      'released version 24 of the ingest worker',
    ],
    ['bumped', 'Bumped jest to 30 across the monorepo.', 'Bumped jest to 30 across the monorepo'],
    [
      'upgraded',
      'We upgraded SurrealDB on staging this morning.',
      'upgraded SurrealDB on staging this morning',
    ],
    [
      'downgraded',
      'I downgraded the kernel after the panic.',
      'downgraded the kernel after the panic',
    ],
    [
      'deprecated',
      'We deprecated the v1 export endpoint today.',
      'deprecated the v1 export endpoint today',
    ],
    [
      'removed',
      'Removed the legacy retry shim from the gateway.',
      'Removed the legacy retry shim from the gateway',
    ],
    [
      'deleted',
      'I deleted the stale feature branch this afternoon.',
      'deleted the stale feature branch this afternoon',
    ],
    [
      'renamed',
      'We renamed the ingestion module last sprint.',
      'renamed the ingestion module last sprint',
    ],
    [
      'migrated',
      'We migrated the changefeed consumers off the polling loop.',
      'migrated the changefeed consumers off the polling loop',
    ],
    [
      'rolled back',
      'We rolled back the schema migration overnight.',
      'rolled back the schema migration overnight',
    ],
  ];

  it.each(CODING_TABLE)('%s → exactly one state_change, span pinned', (_label, turn, span) => {
    const facts = harvest(turn, SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe(STATE_CHANGE_PREDICATE);
    expect(facts[0]!.object).toBe(span);
    expect(facts[0]!.valueSpan).toBe(span);
    expect(facts[0]!.entityIndex).toBe(0);
    expect(facts[0]!.confidence).toBe(STATE_VERB_HARVEST_CONFIDENCE);
  });

  // Held-out phrasing per verb group — a second wording the primary
  // table does not cover, so a lexicon regression cannot hide behind
  // one memorised sentence shape.
  const HELD_OUT: Array<[string, string, string]> = [
    [
      'vcs (merge/revert)',
      'Finally merged the long-running auth refactor.',
      'merged the long-running auth refactor',
    ],
    [
      'flags (enable/disable)',
      'Disabled ANSWER_CACHE for the eu tenants last night.',
      'Disabled ANSWER_CACHE for the eu tenants last night',
    ],
    [
      'shipping (deploy/release)',
      'Released the hotfix to all tenants within the hour.',
      'Released the hotfix to all tenants within the hour',
    ],
    [
      'versions (bump/up/downgrade)',
      'Upgraded node to 22 on the runners.',
      'Upgraded node to 22 on the runners',
    ],
    [
      'retirement (deprecate/remove/delete)',
      'Deprecated the positional-args constructor in favour of options.',
      'Deprecated the positional-args constructor in favour of options',
    ],
    [
      'movement (rename/migrate/rollback)',
      'Rolled back the compaction change after the alert fired.',
      'Rolled back the compaction change after the alert fired',
    ],
  ];

  it.each(HELD_OUT)('held-out %s → harvested with the verbatim span', (_label, turn, span) => {
    const facts = harvest(turn, SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe(STATE_CHANGE_PREDICATE);
    expect(facts[0]!.object).toBe(span);
    expect(facts[0]!.valueSpan).toBe(span);
  });

  // Guards and completed-form construction hold for the new verbs too.
  const CODING_NOTHING: Array<[string, string]> = [
    ['bare-infinitive negation', "We didn't merge the release branch."],
    ['intention idiom + bare infinitive', 'We are planning to deprecate the v1 endpoint.'],
    ['negated completion', "We haven't merged PR #431 yet."],
    ['hypothetical', 'We might revert the cutover if latency regresses.'],
    ['future phrasal', 'We will roll back the migration tomorrow.'],
    ['gerund under consideration', 'We are considering disabling the retry sweep.'],
    ['about-to + bare infinitive', 'We are about to release v2.4.'],
    ['modal suggestion', 'We should probably enable EXTRACTOR_STATE_VERB_HARVEST.'],
    // Passive / verb-final: the object noun phrase is empty, so the
    // matcher harvests NOTHING (no fact at all — never a mis-bound
    // one). The artifact-subject transition is a known lexicon-lane
    // limitation; the code-memory battery measures it.
    ['passive verb-final (PR)', 'PR #431 was merged.'],
    ['passive verb-final (flag)', 'The flag was enabled.'],
  ];

  it.each(CODING_NOTHING)('%s → no facts', (_label, text) => {
    expect(harvest(text, [ent('Sasha'), ent('Priya')], 0)).toEqual([]);
  });

  it('active-voice artifact transition binds to the SPEAKER, not the artifact', () => {
    // Pinned limitation: bindStateHolder only binds person entities
    // (customer | staff); an artifact named in the clause never steals
    // the binding, so "enabled ACME_RETRY_QUEUE" lands on the agent.
    const entities = [ent('ACME_RETRY_QUEUE', 'asset'), ent('Sasha')];
    const facts = harvest(
      'Enabled ACME_RETRY_QUEUE in prod today.',
      entities,
      resolveSpeakerEntityIndex(entities, 'Sasha'),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.entityIndex).toBe(1);
    expect(facts[0]!.object).toBe('Enabled ACME_RETRY_QUEUE in prod today');
  });

  it('dotted values clip at the first dot — the clause boundary includes "."', () => {
    // Known matcher constraint, pinned rather than papered over: the
    // object capture stops at ANY clause-boundary character, and "."
    // is one, so a dotted version ("3.2.4") or dotted path inside the
    // object clips at its first dot. The transition still harvests —
    // the span is verbatim, just truncated. Loosening the boundary is
    // out of scope for an additions-only lexicon change.
    const facts = harvest('We upgraded SurrealDB to 3.2.4 on staging.', SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.object).toBe('upgraded SurrealDB to 3');
    expect(facts[0]!.valueSpan).toBe('upgraded SurrealDB to 3');
  });

  it('phrasal "rolled back" wins as one entry — the span carries the full phrase', () => {
    const facts = harvest('We rolled back the schema migration overnight.', SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.object.startsWith('rolled back ')).toBe(true);
  });

  it('consumer "renamed to" still wins over bare "renamed" when adjacent', () => {
    const facts = harvest('I renamed to my maiden name after the divorce.', SASHA, 0);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.object).toBe('renamed to my maiden name after the divorce');
  });
});

// ── The assembleResult seam ──────────────────────────────────────────
// The union point sits inside ExtractorRunnerService.assembleResult:
// off-state must be byte-identical; on-state unions state-verb facts
// AFTER denoise and AFTER the literal lane, and both lanes compose
// when enabled together. LLM/refine/pattern deps are stubbed —
// assembleResult never touches the LLM.
describe('assembleResult seam (EXTRACTOR_STATE_VERB_HARVEST)', () => {
  const mkRunner = (): ExtractorRunnerService =>
    new ExtractorRunnerService(
      {} as never,
      { persistPatterns: () => {} } as never,
      { applyPredicateRefinements: async () => {} } as never,
    );

  const TRIMMED = 'I quit the chess club today; the club portal runs on port 8443.';

  const rawJson = {
    clauses: ['I quit the chess club today'],
    entities: [{ name: 'Dev', type: 'staff' }],
    facts: [
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'status',
        valueSpan: 'chess',
        confidence: 0.6,
      },
    ],
    edges: [],
  };

  const assemble = async (runner: ExtractorRunnerService) =>
    (
      runner as unknown as {
        assembleResult: (args: {
          companyId: string;
          trimmed: string;
          snapshot: { versionHash: string; active: never[] };
          rawJson: unknown;
          context?: { speakerName?: string };
        }) => Promise<{ entities: ExtractedEntity[]; facts: ExtractedFact[]; edges: unknown[] }>;
      }
    ).assembleResult({
      companyId: 'co_test',
      trimmed: TRIMMED,
      snapshot: { versionHash: 'h', active: [] },
      rawJson,
      context: { speakerName: 'Dev' },
    });

  const STATE_FLAG = 'EXTRACTOR_STATE_VERB_HARVEST';
  const LITERAL_FLAG = 'EXTRACTOR_LITERAL_HARVEST';
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    saved[STATE_FLAG] = process.env[STATE_FLAG];
    saved[LITERAL_FLAG] = process.env[LITERAL_FLAG];
  });
  afterEach(() => {
    for (const flag of [STATE_FLAG, LITERAL_FLAG]) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  it('flag off → output unchanged (deep-equal on the fixture)', async () => {
    delete process.env[STATE_FLAG];
    delete process.env[LITERAL_FLAG];
    const result = await assemble(mkRunner());
    expect(result).toEqual({
      entities: [{ name: 'Dev', type: 'staff', canonical: undefined }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'status',
          object: 'chess',
          confidence: 0.6,
          clause: 'I quit the chess club today',
          valueSpan: 'chess',
        },
      ],
      edges: [],
    });
  });

  it('flag on → the state_change fact is unioned after denoise, LLM facts untouched', async () => {
    delete process.env[LITERAL_FLAG];
    process.env[STATE_FLAG] = '1';
    const result = await assemble(mkRunner());
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toMatchObject({ predicate: 'status', object: 'chess' });
    expect(result.facts[1]).toMatchObject({
      predicate: STATE_CHANGE_PREDICATE,
      object: 'quit the chess club today',
      // Sentence names no entity → falls back to the speaker entity,
      // which groundEntities allow-lists by name.
      entityIndex: 0,
      confidence: STATE_VERB_HARVEST_CONFIDENCE,
    });
  });

  it('both lanes on → harvests concatenate (literal first, then state-verb)', async () => {
    process.env[LITERAL_FLAG] = '1';
    process.env[STATE_FLAG] = '1';
    const result = await assemble(mkRunner());
    expect(result.facts.map((f) => f.predicate)).toEqual([
      'status',
      'service_port',
      STATE_CHANGE_PREDICATE,
    ]);
    expect(result.facts[1]).toMatchObject({ object: '8443' });
    expect(result.facts[2]).toMatchObject({ object: 'quit the chess club today' });
  });
});
