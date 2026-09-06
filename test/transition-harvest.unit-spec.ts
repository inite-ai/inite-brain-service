/**
 * Transition-classifier harvest lane (EXTRACTOR_TRANSITION_CLASSIFIER
 * wiring) — the semantic sibling of the state-verb lexicon lane.
 *
 * NO live BGE-M3 here: the embedder stub is a CLASS ORACLE — every
 * prototype embeds as its class's one-hot basis vector, and each test
 * input embeds by an explicit per-sentence rule (full-strength class
 * basis, a deliberately sub-floor vector, or a deliberately
 * sub-margin two-class blend). Semantic quality is measured by the
 * calibration harness (eval:transition-calibration) against the real
 * embedder; THIS spec pins the wiring mechanics — flag gating,
 * candidate guards, defer-to-lexicon, threshold gates, holder
 * binding, dedup, cap, and the emitted fact shape.
 */
import {
  TRANSITION_CLASSES,
  TRANSITION_MARGIN_DEFAULT,
  TRANSITION_PROTOTYPES,
  TRANSITION_SCORE_FLOOR,
  createTransitionClassifier,
  type TransitionClass,
  type TransitionClassifier,
} from '../src/ai/extractor-internals/transition-classifier';
import {
  TRANSITION_HARVEST_CAP,
  TRANSITION_HARVEST_CONFIDENCE,
  harvestTransitions,
} from '../src/ai/extractor-internals/transition-harvest';
import {
  STATE_CHANGE_PREDICATE,
  STATE_VERB_HARVEST_CONFIDENCE,
} from '../src/ai/extractor-internals/state-verb-harvest';
import { isGroundedSpan, normalizeForGrounding } from '../src/ai/extractor-internals/grounding';
import type { ExtractedEntity, ExtractedFact } from '../src/ai/extractor-internals/types';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import type { EmbedderService } from '../src/ai/embedder.service';

// ── The class-oracle embedding stub ──────────────────────────────────

const CLASS_INDEX: Record<TransitionClass, number> = {
  completed_acquire: 0,
  completed_dispose: 1,
  completed_change: 2,
  intention: 3,
  unrelated: 4,
};
/** 5 class dims + 1 "far from everything" dim. */
const DIM = 6;

const basis = (i: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
};

/** cos to the class basis = exactly `score`; rest of mass off-class. */
const subFloor = (): number[] => {
  const score = Math.max(TRANSITION_SCORE_FLOOR - 0.05, 0.1);
  const v = new Array<number>(DIM).fill(0);
  v[CLASS_INDEX.completed_dispose] = score;
  v[5] = Math.sqrt(1 - score * score);
  return v;
};

/**
 * Two completed classes nearly tied: cos ≈ 0.707 each (clears any
 * floor ≤ 0.7 — guarded below), margin < TRANSITION_MARGIN_DEFAULT.
 */
const subMargin = (): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[CLASS_INDEX.completed_dispose] = 1;
  v[CLASS_INDEX.completed_change] = 1 - TRANSITION_MARGIN_DEFAULT / 2;
  return v;
};

/** Per-sentence oracle rules for the test inputs (clause text). */
const RULES: Array<[RegExp, () => number[]]> = [
  [/parted with/i, () => basis(CLASS_INDEX.completed_dispose)],
  [/продал/i, () => basis(CLASS_INDEX.completed_dispose)],
  [/returned the company car/i, () => basis(CLASS_INDEX.completed_dispose)],
  // Verdict-class gate: a clause the classifier calls INTENTION even
  // though morphology passed it — must not emit.
  [/handed over/i, () => basis(CLASS_INDEX.intention)],
  [/almost sold/i, subFloor],
  [/swapped his sedan/i, subMargin],
];

function protoClassOf(text: string): TransitionClass | null {
  for (const cls of TRANSITION_CLASSES) {
    if (TRANSITION_PROTOTYPES[cls].includes(text)) return cls;
  }
  return null;
}

function embedText(text: string): number[] {
  const proto = protoClassOf(text);
  if (proto) return basis(CLASS_INDEX[proto]);
  for (const [re, make] of RULES) {
    if (re.test(text)) return make();
  }
  return basis(5); // orthogonal to every prototype → sub-floor
}

/** Oracle classifier + call counter (batch payloads recorded). */
function makeClassifier(): { classifier: TransitionClassifier; calls: string[][] } {
  const calls: string[][] = [];
  const classifier = createTransitionClassifier((texts) => {
    calls.push([...texts]);
    return Promise.resolve(texts.map(embedText));
  });
  return { classifier, calls };
}

const ent = (name: string, type: ExtractedEntity['type'] = 'staff'): ExtractedEntity => ({
  name,
  type,
});
const SASHA = [ent('Sasha')];

const harvest = (
  trimmed: string,
  entities: ExtractedEntity[] = SASHA,
  speakerEntityIndex: number | null = 0,
  existingFacts: ExtractedFact[] = [],
): Promise<ExtractedFact[]> => {
  const { classifier } = makeClassifier();
  return harvestTransitions({ trimmed, entities, speakerEntityIndex, existingFacts, classifier });
};

it('the sub-margin stub construction stays valid if the floor recalibrates', () => {
  // subMargin() yields cos ≈ 0.707 to the tied classes; a floor above
  // that would silently turn the margin-gate test into a floor test.
  expect(TRANSITION_SCORE_FLOOR).toBeLessThan(0.7);
});

describe('harvestTransitions — out-of-lexicon EN + RU positives', () => {
  it('"parted with" (in no lexicon) → one span-grounded state_change on the speaker', async () => {
    const text = 'She parted with her old laptop yesterday.';
    const facts = await harvest(text);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      entityIndex: 0,
      predicate: STATE_CHANGE_PREDICATE,
      object: 'She parted with her old laptop yesterday',
      valueSpan: 'She parted with her old laptop yesterday',
      confidence: TRANSITION_HARVEST_CONFIDENCE,
    });
    expect(
      isGroundedSpan(normalizeForGrounding(text), normalizeForGrounding(facts[0]!.valueSpan!)),
    ).toBe(true);
  });

  it('RU positive: "Я продал мотоцикл вчера." harvests via the RU candidate path', async () => {
    const facts = await harvest('Я продал мотоцикл вчера.');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      entityIndex: 0,
      predicate: STATE_CHANGE_PREDICATE,
      object: 'Я продал мотоцикл вчера',
      confidence: TRANSITION_HARVEST_CONFIDENCE,
    });
  });

  it('binds the state HOLDER: a person named in the sentence wins over the speaker', async () => {
    const entities = [ent('Boris', 'customer'), ent('Sasha')];
    const facts = await harvest(
      'Boris returned the company car when he switched jobs.',
      entities,
      1,
    );
    expect(facts.length).toBeGreaterThanOrEqual(1);
    for (const f of facts) expect(f.entityIndex).toBe(0);
  });
});

describe('harvestTransitions — guards (morphology kills these BEFORE any embedding)', () => {
  const GUARDED: Array<[string, string]> = [
    ['negation', "I haven't sold the bike"],
    ['negation (RU)', 'Я не продал мотоцикл.'],
    ['intention idiom', 'I am planning to quit the gym'],
    ['intention (RU)', 'Я собираюсь продать машину.'],
    ['hypothetical modal', 'We might revert the cutover if latency regresses.'],
    ['future', 'I will quit next month'],
    ['governed infinitive', 'She wants to part with her old laptop.'],
    ['bare prose, no transition verb', 'The office is on the third floor.'],
  ];

  it.each(GUARDED)('%s → no facts and the embedder is NEVER called', async (_label, text) => {
    const { classifier, calls } = makeClassifier();
    const facts = await harvestTransitions({
      trimmed: text,
      entities: SASHA,
      speakerEntityIndex: 0,
      classifier,
    });
    expect(facts).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('harvestTransitions — verdict gates (calibrated floor/margin, class acceptance)', () => {
  it('an intention verdict emits nothing even when morphology passed the clause', async () => {
    expect(await harvest('He handed over the keys to the new tenant this morning.')).toEqual([]);
  });

  it('a completed verdict below the score floor emits nothing', async () => {
    expect(await harvest('He almost sold the boat.')).toEqual([]);
  });

  it('a completed verdict below the margin gate (runner-up too close) emits nothing', async () => {
    expect(await harvest('He swapped his sedan for a hatchback.')).toEqual([]);
  });
});

describe('harvestTransitions — composition with the lexicon lane', () => {
  const QUIT_TURN = 'I quit the chess club today; Mondays got too busy at work.';

  it('defers WHOLE sentences the lexicon lane already harvested — no embed call at all', async () => {
    const lexiconFact: ExtractedFact = {
      entityIndex: 0,
      predicate: STATE_CHANGE_PREDICATE,
      object: 'quit the chess club today',
      confidence: STATE_VERB_HARVEST_CONFIDENCE,
      clause: QUIT_TURN,
      valueSpan: 'quit the chess club today',
    };
    const { classifier, calls } = makeClassifier();
    const facts = await harvestTransitions({
      trimmed: QUIT_TURN,
      entities: SASHA,
      speakerEntityIndex: 0,
      existingFacts: [lexiconFact],
      classifier,
    });
    expect(facts).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('dedup: an existing same-(entity, predicate, normalized object) fact suppresses re-emission', async () => {
    const text = 'She parted with her old laptop yesterday.';
    const existing: ExtractedFact = {
      entityIndex: 0,
      predicate: STATE_CHANGE_PREDICATE,
      object: 'She parted with her old laptop yesterday',
      confidence: 0.7,
      // A clause that does NOT claim the sentence — only the triple matches.
      clause: 'unrelated clause',
      valueSpan: 'She parted with her old laptop yesterday',
    };
    expect(await harvest(text, SASHA, 0, [existing])).toEqual([]);
  });

  it('cap: pathological input yields at most TRANSITION_HARVEST_CAP facts', async () => {
    const pathological = Array.from(
      { length: 9 },
      (_, i) => `She parted with laptop number ${i + 1} yesterday.`,
    ).join(' ');
    const facts = await harvest(pathological);
    expect(facts).toHaveLength(TRANSITION_HARVEST_CAP);
  });

  it('no grounded holder anywhere → nothing is emitted', async () => {
    expect(await harvest('She parted with her old laptop yesterday.', [], null)).toEqual([]);
    expect(
      await harvest('She parted with her old laptop yesterday.', [ent('laptop', 'asset')], null),
    ).toEqual([]);
  });
});

// ── The assembleResult seam ──────────────────────────────────────────
// Off-state must be byte-identical (and must never touch the embedder);
// on-state unions classifier facts LAST, after denoise + literal +
// state-verb lanes, and defers to the lexicon lane per sentence.
describe('assembleResult seam (EXTRACTOR_TRANSITION_CLASSIFIER)', () => {
  const embedderStub = (onCall?: () => void): EmbedderService =>
    ({
      embedMany: (texts: string[]): Promise<number[][]> => {
        onCall?.();
        return Promise.resolve(texts.map(embedText));
      },
    }) as unknown as EmbedderService;

  const mkRunner = (embedder?: EmbedderService): ExtractorRunnerService =>
    new ExtractorRunnerService(
      {} as never,
      { persistPatterns: () => {} } as never,
      { applyPredicateRefinements: async () => {} } as never,
      embedder,
    );

  const TRIMMED = 'She parted with her old laptop yesterday; the club portal is fine.';

  const rawJson = {
    clauses: ['She parted with her old laptop yesterday'],
    entities: [{ name: 'Dev', type: 'staff' }],
    facts: [
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'status',
        valueSpan: 'laptop',
        confidence: 0.6,
      },
    ],
    edges: [],
  };

  const assemble = async (
    runner: ExtractorRunnerService,
    trimmed: string = TRIMMED,
    raw: unknown = rawJson,
  ) =>
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
      trimmed,
      snapshot: { versionHash: 'h', active: [] },
      rawJson: raw,
      context: { speakerName: 'Dev' },
    });

  const FLAGS = [
    'EXTRACTOR_TRANSITION_CLASSIFIER',
    'EXTRACTOR_STATE_VERB_HARVEST',
    'EXTRACTOR_LITERAL_HARVEST',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const flag of FLAGS) saved[flag] = process.env[flag];
  });
  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  it('flag off → output byte-identical AND the embedder is never touched', async () => {
    for (const flag of FLAGS) delete process.env[flag];
    const runner = mkRunner(
      embedderStub(() => {
        throw new Error('embedder must not be called with the flag off');
      }),
    );
    const result = await assemble(runner);
    expect(result).toEqual({
      entities: [{ name: 'Dev', type: 'staff', canonical: undefined }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'status',
          object: 'laptop',
          confidence: 0.6,
          clause: 'She parted with her old laptop yesterday',
          valueSpan: 'laptop',
        },
      ],
      edges: [],
    });
  });

  it('flag on → classifier fact unioned LAST, LLM facts untouched', async () => {
    for (const flag of FLAGS) delete process.env[flag];
    process.env['EXTRACTOR_TRANSITION_CLASSIFIER'] = '1';
    const result = await assemble(mkRunner(embedderStub()));
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toMatchObject({ predicate: 'status', object: 'laptop' });
    expect(result.facts[1]).toMatchObject({
      predicate: STATE_CHANGE_PREDICATE,
      object: 'She parted with her old laptop yesterday',
      entityIndex: 0,
      confidence: TRANSITION_HARVEST_CONFIDENCE,
    });
  });

  it('flag on WITHOUT an injected embedder → lane skipped, output as with flag off', async () => {
    for (const flag of FLAGS) delete process.env[flag];
    process.env['EXTRACTOR_TRANSITION_CLASSIFIER'] = '1';
    const result = await assemble(mkRunner(undefined));
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ predicate: 'status', object: 'laptop' });
  });

  it('both transition lanes on + in-lexicon sentence → lexicon wins, NO double fact', async () => {
    for (const flag of FLAGS) delete process.env[flag];
    process.env['EXTRACTOR_STATE_VERB_HARVEST'] = '1';
    process.env['EXTRACTOR_TRANSITION_CLASSIFIER'] = '1';
    const result = await assemble(
      mkRunner(embedderStub()),
      'I quit the chess club today; Mondays got too busy at work.',
      {
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
      },
    );
    const stateChanges = result.facts.filter((f) => f.predicate === STATE_CHANGE_PREDICATE);
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toMatchObject({
      object: 'quit the chess club today',
      confidence: STATE_VERB_HARVEST_CONFIDENCE, // the lexicon lane's fact
    });
  });

  it('both lanes on + out-of-lexicon sentence → the classifier lane still fires', async () => {
    for (const flag of FLAGS) delete process.env[flag];
    process.env['EXTRACTOR_STATE_VERB_HARVEST'] = '1';
    process.env['EXTRACTOR_TRANSITION_CLASSIFIER'] = '1';
    const result = await assemble(mkRunner(embedderStub()));
    const stateChanges = result.facts.filter((f) => f.predicate === STATE_CHANGE_PREDICATE);
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toMatchObject({
      object: 'She parted with her old laptop yesterday',
      confidence: TRANSITION_HARVEST_CONFIDENCE, // the classifier lane's fact
    });
  });
});
