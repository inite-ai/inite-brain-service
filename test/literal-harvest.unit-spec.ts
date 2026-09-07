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
import {
  CODE_MEMORY_DEFAULT_VALUE_PREDICATE,
  CODE_MEMORY_PACK,
} from '../src/ai/domain-packs/code-memory.pack';
import { buildChecks } from './eval/code-memory/corpus';
import { checkHistorySequence } from './eval/state-transitions/scorers';

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

describe('harvestLiterals — k07 rate-limit phrasing table (code-memory battery)', () => {
  // VERBATIM corpus turn from test/eval/code-memory/corpus.ts (the k07
  // rate_limit want) — pins that the deterministic lane produces the
  // fact for this exact phrasing whenever it runs with a grounded
  // entity, so a battery miss localizes upstream of the regex lane.
  const THROTTLE_TURN = 'acme-api throttles /v1/webhooks at 120 requests per minute.';

  it('corpus phrasing: "throttles … at 120 requests per minute" → rate_limit', () => {
    const facts = harvest(THROTTLE_TURN, [ent('acme-api')], null);
    const rate = byPredicate(facts, 'rate_limit');
    expect(rate).toHaveLength(1);
    expect(rate[0]!.object).toBe('120 requests per minute');
    expect(rate[0]!.entityIndex).toBe(0);
    // The cue-gated addition must not double-fire next to the main rule.
    expect(facts).toHaveLength(1);
  });

  it('held-out: cue-gated bare form "rate-limits … at 60 per minute"', () => {
    const facts = harvest(
      'acme-api rate-limits /v1/events at 60 per minute.',
      [ent('acme-api')],
      null,
    );
    expect(byPredicate(facts, 'rate_limit').map((f) => f.object)).toEqual(['60 per minute']);
  });

  it('held-out: cue-gated slash form "throttled to 300/min"', () => {
    const facts = harvest(
      'The acme-api webhook route is throttled to 300/min in staging.',
      [ent('acme-api')],
      null,
    );
    expect(byPredicate(facts, 'rate_limit').map((f) => f.object)).toEqual(['300/min']);
  });

  it('held-out: cue-gated compact unit "quota … is 850 rps"', () => {
    const facts = harvest('The ingest quota for acme-api is 850 rps.', [ent('acme-api')], null);
    expect(byPredicate(facts, 'rate_limit').map((f) => f.object)).toEqual(['850 rps']);
  });

  it('negative: "120 users" never becomes a rate limit, even beside a throttle cue', () => {
    const facts = harvest(
      'acme-api throttles onboarding; 120 users hit the waitlist.',
      [ent('acme-api')],
      null,
    );
    expect(facts).toEqual([]);
  });

  it('negative: cue-less "120 per minute" prose stays out', () => {
    const facts = harvest(
      'The acme-api conveyor demo moved 120 per minute all day.',
      [ent('acme-api')],
      null,
    );
    expect(facts).toEqual([]);
  });

  it('negative: rpm stays out even with a cue (revolutions ambiguity)', () => {
    const facts = harvest('We throttle the acme-api fans at 1200 rpm.', [ent('acme-api')], null);
    expect(facts).toEqual([]);
  });
});

describe('harvestLiterals — k08 flag-default rule (code-memory battery)', () => {
  // VERBATIM corpus turns from test/eval/code-memory/corpus.ts (the k08
  // flag-transition stages). Diagnosed lottery (2026-09, 6-attempt
  // controlled repro on the dogfood stand): the two stages had NO
  // deterministic producer — the state-verb lane drops "we enabled
  // FLAG" when no person/speaker holder exists (agent-recorded turns),
  // and the LLM redraw only sometimes parrots the prose markers into a
  // decided fact. This rule pins the TYPED emission.
  const FLAG_T1 =
    'We introduced the ACME_RETRY_QUEUE flag in acme-api; it ships disabled and its ' +
    'default stays 0 until the queue is proven.';
  const FLAG_T2 =
    'We enabled ACME_RETRY_QUEUE in prod today; its default is now 1 for every acme-api tenant.';
  const flagEntities = (): ExtractedEntity[] => [ent('ACME_RETRY_QUEUE', 'other'), ent('acme-api')];

  it('derives the namespaced predicate from the live builtin manifest', () => {
    expect(CODE_MEMORY_DEFAULT_VALUE_PREDICATE).toBe('code_memory__default_value');
    expect(CODE_MEMORY_PACK.predicates.some((p) => p.localId === 'default_value')).toBe(true);
  });

  it('corpus stage 1: "default stays 0" → default_value "0" ON the flag entity', () => {
    const facts = harvest(FLAG_T1, flagEntities(), null);
    const dv = byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE);
    expect(dv).toHaveLength(1);
    expect(dv[0]!.object).toBe('0');
    expect(dv[0]!.valueSpan).toBe('default stays 0');
    // Subject-directed binding: the flag, never the leading project.
    expect(dv[0]!.entityIndex).toBe(0);
    // The identifier rule still fires; nothing else does.
    expect(byPredicate(facts, 'identifier').map((f) => f.object)).toEqual(['ACME_RETRY_QUEUE']);
    expect(facts).toHaveLength(2);
  });

  it('corpus stage 2: "default is now 1" → default_value "1" ON the flag entity', () => {
    const facts = harvest(FLAG_T2, flagEntities(), null);
    const dv = byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE);
    expect(dv).toHaveLength(1);
    expect(dv[0]!.object).toBe('1');
    expect(dv[0]!.valueSpan).toBe('default is now 1');
    expect(dv[0]!.entityIndex).toBe(0);
  });

  it('LOCKSTEP: the harvested pair satisfies the k08 stage sequence on one timeline', () => {
    const k08 = buildChecks().find((c) => c.id === 'k08-flag-transition');
    if (k08?.kind !== 'flag-transition') throw new Error('k08 shape changed');
    const events = [
      ...harvest(FLAG_T1, flagEntities(), null).map((f) => ({
        predicate: f.predicate,
        object: f.object,
        at: '2026-09-01T15:00:00Z',
      })),
      ...harvest(FLAG_T2, flagEntities(), null).map((f) => ({
        predicate: f.predicate,
        object: f.object,
        at: '2026-09-01T15:20:00Z',
      })),
    ];
    const verdict = checkHistorySequence(events, k08.stages);
    expect(verdict.pass).toBe(true);
  });

  it('held-out: the pack few-shot phrasing "defaults to 0" harvests the typed slot', () => {
    const facts = harvest(
      'EXTRACTOR_LITERAL_HARVEST defaults to 0 in production.',
      [ent('EXTRACTOR_LITERAL_HARVEST', 'other')],
      null,
    );
    const dv = byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE);
    expect(dv.map((f) => f.object)).toEqual(['0']);
  });

  it('held-out: state-word value "remains off"', () => {
    const facts = harvest(
      'The FOO_BAR_MODE default remains off for now.',
      [ent('FOO_BAR_MODE', 'other')],
      null,
    );
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE).map((f) => f.object)).toEqual([
      'off',
    ]);
  });

  it('negative: no ALL_CAPS identifier in the sentence → the prose default stays out', () => {
    const facts = harvest('The timeout default is 10000 in acme-api.', [ent('acme-api')], null);
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('negative: hypothetical is guarded ("should … default at 1")', () => {
    const facts = harvest(
      'We should probably keep the ACME_STRICT_MODE default at 1 next quarter.',
      [ent('ACME_STRICT_MODE', 'other')],
      null,
    );
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('negative: conditional is guarded ("If the … default stays 0")', () => {
    const facts = harvest(
      'If the ACME_RETRY_QUEUE default stays 0, we bail out of the rollout.',
      [ent('ACME_RETRY_QUEUE', 'other')],
      null,
    );
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('negative: historical "defaulted to 0" never matches by construction', () => {
    const facts = harvest(
      'The ACME_RETRY_QUEUE flag defaulted to 0 last year.',
      [ent('ACME_RETRY_QUEUE', 'other')],
      null,
    );
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('negative: a non-value object stays out ("default is the same as prod")', () => {
    const facts = harvest(
      'The ACME_RETRY_QUEUE default is the same as prod.',
      [ent('ACME_RETRY_QUEUE', 'other')],
      null,
    );
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('dedup: an LLM-emitted default_value on the flag suppresses the harvest twin', () => {
    const existing: ExtractedFact[] = [
      {
        entityIndex: 0,
        predicate: CODE_MEMORY_DEFAULT_VALUE_PREDICATE,
        object: '0',
        confidence: 0.9,
        valueSpan: '0',
      },
    ];
    const facts = harvest(FLAG_T1, flagEntities(), null, existing);
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('honest drop: identifier absent from the entity list and minting off → no default fact', () => {
    const facts = harvest(FLAG_T1, [ent('acme-api')], null);
    expect(byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE)).toEqual([]);
  });

  it('mint path: a no-entity turn mints the flag and binds the default to it', () => {
    const entities: ExtractedEntity[] = [];
    const facts = harvestLiterals({
      trimmed: FLAG_T1,
      entities,
      speakerEntityIndex: null,
      mintSubjects: true,
    });
    const dv = byPredicate(facts, CODE_MEMORY_DEFAULT_VALUE_PREDICATE);
    expect(dv).toHaveLength(1);
    expect(entities[dv[0]!.entityIndex]).toEqual({ name: 'ACME_RETRY_QUEUE', type: 'other' });
  });

  it('every flag-default valueSpan passes the grounding gate by construction', () => {
    for (const text of [FLAG_T1, FLAG_T2]) {
      for (const f of harvest(text, flagEntities(), null)) {
        expect(
          isGroundedSpan(normalizeForGrounding(text), normalizeForGrounding(f.valueSpan!)),
        ).toBe(true);
      }
    }
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
