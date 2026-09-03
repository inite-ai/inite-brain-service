/**
 * Deterministic literal-harvest lane (EXTRACTOR_LITERAL_HARVEST,
 * memory-fitness lever #1 — Design A). Fixtures are the VERBATIM
 * corpus sentences from test/eval/memory-fitness/corpus.ts — the turns
 * whose literals the closed-vocab LLM extraction measurably dropped.
 */
import {
  DURATION_LIMIT_PATTERN,
  LITERAL_HARVEST_CAP,
  LITERAL_HARVEST_CONFIDENCE,
  harvestLiterals,
  resolveSpeakerEntityIndex,
} from '../src/ai/extractor-internals/literal-harvest';
import { isGroundedSpan, normalizeForGrounding } from '../src/ai/extractor-internals/grounding';
import type { ExtractedEntity, ExtractedFact } from '../src/ai/extractor-internals/types';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';

const ent = (name: string, type: ExtractedEntity['type'] = 'project'): ExtractedEntity => ({
  name,
  type,
});

/** Positional convenience over the options-object production signature. */
const harvest = (
  trimmed: string,
  entities: ExtractedEntity[],
  speakerEntityIndex: number | null,
  existingFacts: ExtractedFact[] = [],
): ExtractedFact[] => harvestLiterals({ trimmed, entities, speakerEntityIndex, existingFacts });

// ── Verbatim corpus fixtures ─────────────────────────────────────────
const RATE_LIMIT_TURN =
  'Constraint: the Meridian sandbox rate limit is 50 requests per minute. Exceeding it returns HTTP 429 and poisons the test run.';
const PREFIX_TURN =
  'Convention: every ledger-sync feature flag is prefixed LSYNC_ — for example LSYNC_REPLAY_ENABLED. No unprefixed flags.';
const SUBJECTS_TURN =
  'Convention: JetStream subjects for ledger-sync are named LSYNC.payouts.* — one subject per payout state transition.';
const PORT_PICK_TURN =
  'I picked port 8443 for the ledger-sync HTTP service. That is the port the service listens on everywhere: local, staging, production.';
const PORTS_LIST_TURN =
  'Ports taken by ledger-sync so far: 8443 for the HTTP service, 9464 for metrics, 8081 for the admin console. Pick something else for anything new.';
const ENQUEUE_IDIOM_TURN =
  'Fix idiom (2026-03-10): every enqueue in ledger-sync now carries idempotencyKey = sha256(payoutId + attemptDate). The worker drops any job whose key it has already processed.';
const PA_TICKET_TURN =
  'Symptom: payout PA-1077 was paid twice on 2026-03-08. The ledger shows two identical transfers three minutes apart.';

const byPredicate = (facts: ExtractedFact[], predicate: string): ExtractedFact[] =>
  facts.filter((f) => f.predicate === predicate);

describe('harvestLiterals — positive table (verbatim corpus turns)', () => {
  it('rate-limit turn → rate_limit "50 requests per minute" + http_status "429"', () => {
    const entities = [ent('Meridian', 'other'), ent('Dev', 'staff')];
    const facts = harvest(RATE_LIMIT_TURN, entities, 1);
    expect(facts).toHaveLength(2);
    const rate = byPredicate(facts, 'rate_limit');
    expect(rate).toHaveLength(1);
    expect(rate[0]!.object).toBe('50 requests per minute');
    // Clause-overlap binding: "Meridian" occurs in the first sentence.
    expect(rate[0]!.entityIndex).toBe(0);
    const status = byPredicate(facts, 'http_status');
    expect(status).toHaveLength(1);
    expect(status[0]!.object).toBe('429');
    // "Exceeding it returns HTTP 429…" names no entity → speaker fallback.
    expect(status[0]!.entityIndex).toBe(1);
    for (const f of facts) expect(f.confidence).toBe(LITERAL_HARVEST_CONFIDENCE);
  });

  it('LSYNC_ convention turn → naming_prefix "LSYNC_" + identifier "LSYNC_REPLAY_ENABLED"', () => {
    const facts = harvest(PREFIX_TURN, [ent('ledger-sync')], null);
    expect(facts).toHaveLength(2);
    expect(byPredicate(facts, 'naming_prefix').map((f) => f.object)).toEqual(['LSYNC_']);
    expect(byPredicate(facts, 'identifier').map((f) => f.object)).toEqual(['LSYNC_REPLAY_ENABLED']);
  });

  it('JetStream subjects turn → identifier "LSYNC.payouts.*" (glob tail kept)', () => {
    const facts = harvest(SUBJECTS_TURN, [ent('ledger-sync')], null);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('identifier');
    expect(facts[0]!.object).toBe('LSYNC.payouts.*');
  });

  it('port-pick turn → exactly one service_port "8443" (statement + list forms dedup)', () => {
    const facts = harvest(PORT_PICK_TURN, [ent('ledger-sync')], null);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('service_port');
    expect(facts[0]!.object).toBe('8443');
  });

  it('ports-list turn → service_port × 3 (8443, 9464, 8081)', () => {
    const facts = harvest(PORTS_LIST_TURN, [ent('ledger-sync')], null);
    expect(byPredicate(facts, 'service_port').map((f) => f.object)).toEqual([
      '8443',
      '9464',
      '8081',
    ]);
    expect(facts).toHaveLength(3);
  });

  it('enqueue idiom turn → identifier "idempotencyKey" only (payoutId/attemptDate stay out)', () => {
    const facts = harvest(ENQUEUE_IDIOM_TURN, [ent('ledger-sync')], null);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('identifier');
    expect(facts[0]!.object).toBe('idempotencyKey');
  });
});

describe('harvestLiterals — negative table', () => {
  const NOTHING: Array<[string, string]> = [
    ['casual duration', 'we met three minutes apart'],
    ['bare date', '2026-03-10'],
    ['plain prose', 'Priya owns the Meridian integration on our side.'],
    // Pinned decision: hyphenated ticket ids are NOT harvested — the
    // identifier family requires underscore, dot, or camelCase.
    ['PA-1077 ticket id', PA_TICKET_TURN],
  ];
  it.each(NOTHING)('%s → no facts', (_label, text) => {
    const facts = harvest(text, [ent('ledger-sync'), ent('Priya', 'staff')], 0);
    expect(facts).toEqual([]);
  });

  it('duration pattern ships but stays dark (regex works, rule not active)', () => {
    const m = [
      ...'Log retention for ledger-sync is 30 days in Loki.'.matchAll(DURATION_LIMIT_PATTERN),
    ];
    expect(m.map((x) => x[0])).toEqual(['30 days']);
    const facts = harvest(
      'Log retention for ledger-sync is 30 days in Loki.',
      [ent('ledger-sync')],
      null,
    );
    expect(facts).toEqual([]);
  });
});

describe('harvestLiterals — invariants', () => {
  it('every harvested valueSpan passes the grounding gate by construction', () => {
    const cases: Array<[string, ExtractedEntity[]]> = [
      [RATE_LIMIT_TURN, [ent('Meridian', 'other'), ent('Dev', 'staff')]],
      [PREFIX_TURN, [ent('ledger-sync')]],
      [SUBJECTS_TURN, [ent('ledger-sync')]],
      [PORT_PICK_TURN, [ent('ledger-sync')]],
      [PORTS_LIST_TURN, [ent('ledger-sync')]],
      [ENQUEUE_IDIOM_TURN, [ent('ledger-sync')]],
    ];
    let checked = 0;
    for (const [text, entities] of cases) {
      for (const f of harvest(text, entities, entities.length - 1)) {
        expect(
          isGroundedSpan(normalizeForGrounding(text), normalizeForGrounding(f.valueSpan!)),
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it('dedup: a pre-existing same-(entity, predicate, object) fact suppresses the harvest', () => {
    const existing: ExtractedFact[] = [
      {
        entityIndex: 0,
        predicate: 'service_port',
        object: '8443',
        confidence: 0.8,
        valueSpan: '8443',
      },
    ];
    expect(harvest(PORT_PICK_TURN, [ent('ledger-sync')], null, existing)).toEqual([]);
  });

  it('cap: pathological input with 20 matches yields at most 6 facts', () => {
    const pathological =
      'gateway ports: ' + Array.from({ length: 20 }, (_, i) => `port ${8001 + i}`).join(', ') + '.';
    const facts = harvest(pathological, [ent('gateway', 'asset')], null);
    expect(facts).toHaveLength(LITERAL_HARVEST_CAP);
  });

  it('no grounded actor anywhere → nothing is emitted', () => {
    expect(harvest(PORT_PICK_TURN, [ent('unrelated-name')], null)).toEqual([]);
    expect(harvest(PORT_PICK_TURN, [], null)).toEqual([]);
  });

  it('resolveSpeakerEntityIndex maps the speaker name onto the entity list', () => {
    const entities = [ent('Meridian', 'other'), ent('Dev', 'staff')];
    expect(resolveSpeakerEntityIndex(entities, 'Dev')).toBe(1);
    expect(resolveSpeakerEntityIndex(entities, 'dev')).toBe(1);
    expect(resolveSpeakerEntityIndex(entities, 'Nobody')).toBeNull();
    expect(resolveSpeakerEntityIndex(entities, undefined)).toBeNull();
  });
});

// ── The assembleResult seam ──────────────────────────────────────────
// The union point sits inside ExtractorRunnerService.assembleResult:
// off-state must be byte-identical, on-state unions harvested facts
// AFTER denoise. LLM/refine/pattern deps are stubbed — assembleResult
// never touches the LLM.
describe('assembleResult seam (EXTRACTOR_LITERAL_HARVEST)', () => {
  const mkRunner = (): ExtractorRunnerService =>
    new ExtractorRunnerService(
      {} as never,
      { persistPatterns: () => {} } as never,
      { applyPredicateRefinements: async () => {} } as never,
    );

  const rawJson = {
    clauses: ['the Meridian sandbox rate limit is 50 requests per minute'],
    entities: [
      { name: 'Meridian', type: 'other' },
      { name: 'Dev', type: 'staff' },
    ],
    facts: [
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'status',
        valueSpan: 'sandbox',
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
      trimmed: RATE_LIMIT_TURN,
      snapshot: { versionHash: 'h', active: [] },
      rawJson,
      context: { speakerName: 'Dev' },
    });

  const FLAG = 'EXTRACTOR_LITERAL_HARVEST';
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it('flag off → output unchanged (deep-equal on the fixture)', async () => {
    delete process.env[FLAG];
    const result = await assemble(mkRunner());
    expect(result).toEqual({
      entities: [
        { name: 'Meridian', type: 'other', canonical: undefined },
        { name: 'Dev', type: 'staff', canonical: undefined },
      ],
      facts: [
        {
          entityIndex: 0,
          predicate: 'status',
          object: 'sandbox',
          confidence: 0.6,
          clause: 'the Meridian sandbox rate limit is 50 requests per minute',
          valueSpan: 'sandbox',
        },
      ],
      edges: [],
    });
  });

  it('flag on → harvested facts are unioned after denoise, LLM facts untouched', async () => {
    process.env[FLAG] = '1';
    const result = await assemble(mkRunner());
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0]).toMatchObject({ predicate: 'status', object: 'sandbox' });
    const harvested = result.facts.slice(1);
    expect(harvested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'rate_limit',
          object: '50 requests per minute',
          entityIndex: 0,
          confidence: LITERAL_HARVEST_CONFIDENCE,
        }),
        expect.objectContaining({
          predicate: 'http_status',
          object: '429',
          // Sentence names no entity → falls back to the speaker
          // entity, which groundEntities allow-lists by name.
          entityIndex: 1,
          confidence: LITERAL_HARVEST_CONFIDENCE,
        }),
      ]),
    );
  });
});
