/**
 * Harvest-lane starvation fixes (code-memory battery k07, two live
 * runs): the deterministic lanes used to be starved on exactly the
 * turns they matter most for —
 *
 *  1. a zero-entity LLM extraction reached the harvest seam with an
 *     empty entity list, every lane bailed, and the ingest boundary
 *     then skipped the mention as `no_entities` — so "acme-api
 *     throttles /v1/webhooks at 120 requests per minute." produced NO
 *     rate_limit fact even though the RATE_LIMIT regex provably
 *     matches it;
 *  2. the trySkip local-replay path returned BEFORE the harvest seam,
 *     while replay patterns deliberately carry the LLM facts only (the
 *     lanes are promised to "re-derive on every ingest") — a replayed
 *     turn silently lost every harvested fact.
 *
 * The fix is gated by the lanes' own flags (no new flag): with every
 * lane off, both paths are byte-identical to before.
 */
import { harvestLiterals } from '../src/ai/extractor-internals/literal-harvest';
import type {
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
} from '../src/ai/extractor-internals/types';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';

// VERBATIM corpus turn from test/eval/code-memory/corpus.ts (the k07
// rate_limit want, the measured miss of both live battery runs).
const THROTTLE_TURN = 'acme-api throttles /v1/webhooks at 120 requests per minute.';

const FLAGS = [
  'EXTRACTOR_LITERAL_HARVEST',
  'EXTRACTOR_STATE_VERB_HARVEST',
  'EXTRACTOR_TRANSITION_CLASSIFIER',
  'EXTRACTOR_SKIP_LLM_ENABLED',
  'EXTRACTOR_DIALOGUE_PROFILE',
] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const flag of FLAGS) saved[flag] = process.env[flag];
});
beforeEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});
afterAll(() => {
  for (const flag of FLAGS) {
    if (saved[flag] === undefined) delete process.env[flag];
    else process.env[flag] = saved[flag];
  }
});

// ── Lane level: the mintSubjects fallback grounding path ─────────────
describe('harvestLiterals — mintSubjects fallback (no-entity turns)', () => {
  it('k07 throttle turn, zero entities → rate_limit bound to a minted "acme-api" subject', () => {
    const entities: ExtractedEntity[] = [];
    const facts = harvestLiterals({
      trimmed: THROTTLE_TURN,
      entities,
      speakerEntityIndex: null,
      mintSubjects: true,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      predicate: 'rate_limit',
      object: '120 requests per minute',
      entityIndex: 0,
    });
    // The subject is minted from the sentence's leading identifier-shaped
    // token (the code-memory extractionProfile doctrine), typed `other`
    // so bindStateHolder can never pick it as a state holder.
    expect(entities).toEqual([{ name: 'acme-api', type: 'other' }]);
  });

  it('identifier-class match becomes its OWN subject entity', () => {
    const entities: ExtractedEntity[] = [];
    const facts = harvestLiterals({
      trimmed: 'ACME_RETRY_QUEUE stays disabled until the backfill lands.',
      entities,
      speakerEntityIndex: null,
      mintSubjects: true,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      predicate: 'identifier',
      object: 'ACME_RETRY_QUEUE',
      entityIndex: 0,
    });
    expect(entities).toEqual([{ name: 'ACME_RETRY_QUEUE', type: 'other' }]);
  });

  it('minted sentence subject beats the speaker fallback (bindEntity priority preserved)', () => {
    const entities: ExtractedEntity[] = [{ name: 'Dev', type: 'staff' }];
    const facts = harvestLiterals({
      trimmed: THROTTLE_TURN,
      entities,
      speakerEntityIndex: 0,
      mintSubjects: true,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.entityIndex).toBe(1);
    expect(entities[1]).toEqual({ name: 'acme-api', type: 'other' });
  });

  it('no subject shape in the sentence → speaker fallback still applies', () => {
    const entities: ExtractedEntity[] = [{ name: 'Dev', type: 'staff' }];
    const facts = harvestLiterals({
      trimmed: 'Exceeding it returns HTTP 429 and poisons the test run.',
      entities,
      speakerEntityIndex: 0,
      mintSubjects: true,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ predicate: 'http_status', object: '429', entityIndex: 0 });
    expect(entities).toHaveLength(1); // nothing minted
  });

  it('no subject shape and no speaker → the match is skipped, never invented', () => {
    const entities: ExtractedEntity[] = [];
    const facts = harvestLiterals({
      trimmed: 'Exceeding it returns HTTP 429 and poisons the test run.',
      entities,
      speakerEntityIndex: null,
      mintSubjects: true,
    });
    expect(facts).toEqual([]);
    expect(entities).toEqual([]);
  });

  it('a rate token never reads as a path subject ("300/min" must not self-subject)', () => {
    const entities: ExtractedEntity[] = [];
    const facts = harvestLiterals({
      trimmed: 'The route is throttled to 300/min in staging.',
      entities,
      speakerEntityIndex: null,
      mintSubjects: true,
    });
    expect(facts).toEqual([]);
    expect(entities).toEqual([]);
  });

  it('mintSubjects absent → byte-identical starved behavior (zero entities harvest nothing)', () => {
    expect(
      harvestLiterals({ trimmed: THROTTLE_TURN, entities: [], speakerEntityIndex: null }),
    ).toEqual([]);
  });
});

// ── Runner level: both starvation paths through run() ────────────────
type LlmStub = {
  composeSystemPrompt: () => string;
  scPasses: number;
  callLlm: jest.Mock;
  modelId: () => string;
};

const mkLlm = (rawJson: unknown): LlmStub => ({
  composeSystemPrompt: () => 'system',
  scPasses: 1,
  callLlm: jest.fn(async () => rawJson),
  modelId: () => 'stub-model',
});

const mkRunner = (
  llm: LlmStub,
  trySkipResult: ExtractionResult | null = null,
): { runner: ExtractorRunnerService; trySkip: jest.Mock } => {
  const trySkip = jest.fn(async () => trySkipResult);
  const runner = new ExtractorRunnerService(
    llm as never,
    { trySkip, persistPatterns: () => {} } as never,
    { applyPredicateRefinements: async () => {} } as never,
  );
  return { runner, trySkip };
};

const EMPTY_RAW = { entities: [], clauses: [], facts: [], edges: [] };
const SNAPSHOT = { versionHash: 'h', active: [] };

describe('run() — the no_entities starvation path (zero-entity LLM extraction)', () => {
  it('all lanes off → byte-identical empty result (mention still skips as no_entities)', async () => {
    const { runner } = mkRunner(mkLlm(EMPTY_RAW));
    const result = await runner.run({
      trimmed: THROTTLE_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result).toEqual({ entities: [], facts: [], edges: [] });
  });

  it('literal lane on → the k07 rate_limit lands on a minted acme-api entity', async () => {
    process.env['EXTRACTOR_LITERAL_HARVEST'] = '1';
    const { runner } = mkRunner(mkLlm(EMPTY_RAW));
    const result = await runner.run({
      trimmed: THROTTLE_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result).toEqual({
      entities: [{ name: 'acme-api', type: 'other' }],
      facts: [
        expect.objectContaining({
          predicate: 'rate_limit',
          object: '120 requests per minute',
          entityIndex: 0,
        }),
      ],
      edges: [],
    });
  });

  it('state-verb lane on + known speaker → state_change binds to the minted speaker', async () => {
    process.env['EXTRACTOR_STATE_VERB_HARVEST'] = '1';
    const { runner } = mkRunner(mkLlm(EMPTY_RAW));
    const result = await runner.run({
      trimmed: 'I sold my ThinkPad today.',
      companyId: 'co_test',
      snapshot: SNAPSHOT,
      context: { speakerName: 'Dev' },
    });
    // The speaker entity is minted from caller-supplied context (typed
    // `staff` — the same type the local NER path assigns a PERSON).
    expect(result).toEqual({
      entities: [{ name: 'Dev', type: 'staff' }],
      facts: [
        expect.objectContaining({
          predicate: 'state_change',
          object: 'sold my ThinkPad today',
          entityIndex: 0,
        }),
      ],
      edges: [],
    });
  });

  it('state-verb lane on, NO speaker → honest skip (no holder is ever invented)', async () => {
    process.env['EXTRACTOR_STATE_VERB_HARVEST'] = '1';
    const { runner } = mkRunner(mkLlm(EMPTY_RAW));
    const result = await runner.run({
      trimmed: 'I sold my ThinkPad today.',
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result).toEqual({ entities: [], facts: [], edges: [] });
  });

  it('a minted speaker no fact references is pruned from the result', async () => {
    process.env['EXTRACTOR_LITERAL_HARVEST'] = '1';
    const { runner } = mkRunner(mkLlm(EMPTY_RAW));
    const result = await runner.run({
      trimmed: THROTTLE_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
      context: { speakerName: 'Dev' },
    });
    // The rate_limit binds to the sentence subject, not the speaker; a
    // speaker-only entity list must not turn the no_entities skip into
    // a facts-less persisted mention.
    expect(result!.entities).toEqual([{ name: 'acme-api', type: 'other' }]);
    expect(result!.facts).toEqual([
      expect.objectContaining({ predicate: 'rate_limit', entityIndex: 0 }),
    ]);
  });

  it('turns WITH entities never mint (no duplicate subject, no double harvest)', async () => {
    process.env['EXTRACTOR_LITERAL_HARVEST'] = '1';
    const raw = {
      entities: [{ name: 'acme-api', type: 'project' }],
      clauses: [],
      facts: [],
      edges: [],
    };
    const { runner } = mkRunner(mkLlm(raw));
    const result = await runner.run({
      trimmed: THROTTLE_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result!.entities).toEqual([{ name: 'acme-api', type: 'project', canonical: undefined }]);
    const rateFacts = result!.facts.filter((f: ExtractedFact) => f.predicate === 'rate_limit');
    expect(rateFacts).toHaveLength(1);
    expect(rateFacts[0]!.entityIndex).toBe(0);
  });
});

describe('run() — the trySkip replay starvation path', () => {
  const REPLAY_TURN = 'I picked port 8443 for the ledger-sync HTTP service.';
  const mkReplay = (): ExtractionResult => ({
    entities: [{ name: 'ledger-sync', type: 'project' }],
    facts: [{ entityIndex: 0, predicate: 'status', object: 'active', confidence: 0.9 }],
    edges: [],
  });

  it('all lanes off → the exact trySkip object is returned, LLM untouched', async () => {
    const replay = mkReplay();
    const llm = mkLlm(EMPTY_RAW);
    const { runner } = mkRunner(llm, replay);
    const result = await runner.run({
      trimmed: REPLAY_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result).toBe(replay); // byte-identical: same reference
    expect(llm.callLlm).not.toHaveBeenCalled();
  });

  it('literal lane on → the replayed result gains the harvested service_port', async () => {
    process.env['EXTRACTOR_LITERAL_HARVEST'] = '1';
    const replay = mkReplay();
    const llm = mkLlm(EMPTY_RAW);
    const { runner } = mkRunner(llm, replay);
    const result = await runner.run({
      trimmed: REPLAY_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(llm.callLlm).not.toHaveBeenCalled();
    expect(result!.entities).toEqual(replay.entities);
    expect(result!.facts).toEqual([
      replay.facts[0],
      expect.objectContaining({ predicate: 'service_port', object: '8443', entityIndex: 0 }),
    ]);
    // The replayed object itself is never mutated.
    expect(replay.facts).toHaveLength(1);
  });

  it('lane on but every harvest already replayed → the exact trySkip object again', async () => {
    process.env['EXTRACTOR_LITERAL_HARVEST'] = '1';
    const replay: ExtractionResult = {
      entities: [{ name: 'ledger-sync', type: 'project' }],
      facts: [{ entityIndex: 0, predicate: 'service_port', object: '8443', confidence: 0.95 }],
      edges: [],
    };
    const { runner } = mkRunner(mkLlm(EMPTY_RAW), replay);
    const result = await runner.run({
      trimmed: REPLAY_TURN,
      companyId: 'co_test',
      snapshot: SNAPSHOT,
    });
    expect(result).toBe(replay);
  });
});
