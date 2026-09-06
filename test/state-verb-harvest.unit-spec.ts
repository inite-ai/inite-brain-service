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

  it('s09 third-party turn binds to Boris by clause overlap, not the speaker', () => {
    const entities = [ent('Boris', 'other'), ent('Sasha')];
    const facts = harvest(S09_RETURN_TURN, entities, resolveSpeakerEntityIndex(entities, 'Sasha'));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.object).toBe('returned the company car');
    expect(facts[0]!.entityIndex).toBe(0);
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
