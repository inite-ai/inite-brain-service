/**
 * G2 L3 escalation — unit coverage of the pure decision core and the
 * service orchestration with mocked IO.
 *
 *  - Trigger matrix: fires only on verdict-fail + coverage-below-floor +
 *    (post-refine | search-loop-off); monotone (already-escalated never
 *    re-enters).
 *  - Session selection: rank by fact-hit density, temporal-overlap
 *    preference for windowed (temporal-class) questions.
 *  - Service: anchor requirement (no session → skipped_no_anchor, no
 *    full-context call), the flip / no-flip telemetry, and the
 *    over-budget → widened-window degrade path.
 */
import type OpenAI from 'openai';
import {
  l3TriggerDecision,
  rankL3Sessions,
  verifierPasses,
  estimateTokens,
  adaptiveL3SessionCount,
  type L3SessionAnchor,
} from '../src/synthesize/l3-escalation';
import { hasUsableCalibration } from '../src/synthesize/focus-signal';
import type { PerClassCalibration } from '../src/synthesize/focus-signal';
import { L3EscalationService } from '../src/synthesize/l3-escalation.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';
import type { RetrievalProfile } from '../src/search/retrieval-profile';
import type { SearchHit } from '../src/search/search.types';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type { Citation } from '../src/synthesize/fact-index';
import type { VerifierOutput } from '../src/synthesize/verifier';

// ── pure: trigger matrix ────────────────────────────────────────────
describe('l3TriggerDecision — the monotone trigger matrix', () => {
  const base = {
    l3Escalation: true,
    verdict: 'unsupported' as VerifierOutput['verdict'],
    covered: false,
    refineAttempted: false,
    searchLoop: false,
    escalated: false,
  };

  it('fires on verdict-fail + below-floor + search-loop off', () => {
    expect(l3TriggerDecision(base)).toBe('fire');
  });

  it('fires on the supported-but-not-answering abstain-intent', () => {
    expect(
      l3TriggerDecision({
        ...base,
        verdict: 'supported',
        questionAnswered: false,
      }),
    ).toBe('fire');
  });

  it('monotone: already-escalated goes straight to skip (no re-entry)', () => {
    expect(l3TriggerDecision({ ...base, escalated: true })).toBe('skip_already_escalated');
  });

  it('skips when the flag is off', () => {
    expect(l3TriggerDecision({ ...base, l3Escalation: false })).toBe('skip_flag_off');
  });

  it('skips a supported+answering verdict', () => {
    expect(
      l3TriggerDecision({
        ...base,
        verdict: 'supported',
        questionAnswered: true,
      }),
    ).toBe('skip_verdict_ok');
  });

  it('skips when coverage is above the floor', () => {
    expect(l3TriggerDecision({ ...base, covered: true })).toBe('skip_covered');
  });

  it('requires a refine first when the search loop is on', () => {
    expect(l3TriggerDecision({ ...base, searchLoop: true, refineAttempted: false })).toBe(
      'skip_no_refine',
    );
    expect(l3TriggerDecision({ ...base, searchLoop: true, refineAttempted: true })).toBe('fire');
  });
});

// ── pure: Optics-2 adaptive trigger (§4.1) ──────────────────────────
describe('l3TriggerDecision — the adaptive confidence gate replaces coverage', () => {
  const base = {
    l3Escalation: true,
    verdict: 'unsupported' as VerifierOutput['verdict'],
    // `covered` set TRUE so a static run here would SKIP: this isolates
    // that the adaptive gate — not the coverage floor — is what decides.
    covered: true,
    refineAttempted: false,
    searchLoop: false,
    escalated: false,
  };

  it('fires when calibrated confidence is below threshold (despite covered=true)', () => {
    expect(l3TriggerDecision({ ...base, adaptive: { confidence: 0.2, threshold: 0.5 } })).toBe(
      'fire',
    );
  });

  it('skips (skip_confident) when confidence is at/above threshold', () => {
    expect(l3TriggerDecision({ ...base, adaptive: { confidence: 0.5, threshold: 0.5 } })).toBe(
      'skip_confident',
    );
    expect(l3TriggerDecision({ ...base, adaptive: { confidence: 0.9, threshold: 0.5 } })).toBe(
      'skip_confident',
    );
  });

  it('KEEPS the anchor-adjacent hard guards on the adaptive path', () => {
    const low = { confidence: 0.1, threshold: 0.5 };
    // monotone single-shot: already-escalated never re-enters, even low-conf.
    expect(l3TriggerDecision({ ...base, escalated: true, adaptive: low })).toBe(
      'skip_already_escalated',
    );
    // flag off short-circuits before the confidence gate.
    expect(l3TriggerDecision({ ...base, l3Escalation: false, adaptive: low })).toBe(
      'skip_flag_off',
    );
    // verdict-ok still wins: confidence only gates a verdict-FAIL.
    expect(
      l3TriggerDecision({
        ...base,
        verdict: 'supported',
        questionAnswered: true,
        adaptive: low,
      }),
    ).toBe('skip_verdict_ok');
    // refine ordering still enforced when the search loop is on.
    expect(
      l3TriggerDecision({ ...base, searchLoop: true, refineAttempted: false, adaptive: low }),
    ).toBe('skip_no_refine');
  });

  it('no adaptive gate → IDENTICAL decision to the static coverage path', () => {
    // The load-bearing safety property, at the decision core: for every
    // combination of the shared inputs, omitting `adaptive` reproduces the
    // static outcome exactly (adaptive undefined ⇒ the coverage branch).
    for (const covered of [true, false]) {
      for (const verdict of ['supported', 'partial', 'unsupported'] as const) {
        for (const questionAnswered of [undefined, true, false] as const) {
          for (const searchLoop of [true, false]) {
            for (const refineAttempted of [true, false]) {
              const shared = {
                l3Escalation: true,
                verdict,
                questionAnswered,
                covered,
                refineAttempted,
                searchLoop,
                escalated: false,
              };
              // Static reference: today's core, no adaptive field.
              const staticReason = l3TriggerDecision(shared);
              // Same inputs, adaptive explicitly undefined → must match.
              expect(l3TriggerDecision({ ...shared, adaptive: undefined })).toBe(staticReason);
            }
          }
        }
      }
    }
  });
});

// ── pure: Optics-2 depth scaling (§4.1) ─────────────────────────────
describe('adaptiveL3SessionCount — #sessions ∝ deficit, capped', () => {
  it('lowest confidence → the full (capped) budget', () => {
    expect(adaptiveL3SessionCount({ confidence: 0, threshold: 0.5, maxSessions: 3 })).toBe(3);
  });

  it('confidence just below threshold → the floor of one session', () => {
    expect(adaptiveL3SessionCount({ confidence: 0.45, threshold: 0.5, maxSessions: 3 })).toBe(1);
  });

  it('scales monotonically with the deficit', () => {
    const a = adaptiveL3SessionCount({ confidence: 0.4, threshold: 0.5, maxSessions: 10 });
    const b = adaptiveL3SessionCount({ confidence: 0.2, threshold: 0.5, maxSessions: 10 });
    const c = adaptiveL3SessionCount({ confidence: 0.05, threshold: 0.5, maxSessions: 10 });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThanOrEqual(10);
  });

  it('NEVER exceeds the static cap and NEVER drops below one', () => {
    for (const conf of [0, 0.1, 0.3, 0.49, 0.5, 0.99]) {
      const n = adaptiveL3SessionCount({ confidence: conf, threshold: 0.5, maxSessions: 4 });
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
    }
  });

  it('degenerate threshold (≤0) falls back to the capped budget, no divide-by-zero', () => {
    expect(adaptiveL3SessionCount({ confidence: 0.2, threshold: 0, maxSessions: 3 })).toBe(3);
    expect(
      Number.isFinite(adaptiveL3SessionCount({ confidence: 0.2, threshold: -1, maxSessions: 3 })),
    ).toBe(true);
  });
});

// ── pure: the no-model→static gate predicate ────────────────────────
describe('hasUsableCalibration — the adaptive-vs-static gate', () => {
  it('empty map (nothing persisted) → not usable', () => {
    expect(hasUsableCalibration({})).toBe(false);
  });

  it('bootstrap-only (all sampleCount 0) → not usable', () => {
    const boot: PerClassCalibration = { default: { thresholds: [1], values: [1], sampleCount: 0 } };
    expect(hasUsableCalibration(boot)).toBe(false);
  });

  it('at least one class fit from real samples → usable', () => {
    const real: PerClassCalibration = {
      default: { thresholds: [1], values: [0.6], sampleCount: 120 },
    };
    expect(hasUsableCalibration(real)).toBe(true);
  });
});

// ── pure: session selection ─────────────────────────────────────────
describe('rankL3Sessions — density + temporal overlap', () => {
  it('ranks by fact-hit density, then summed score', () => {
    const anchors: L3SessionAnchor[] = [
      { conversationId: 'a', score: 0.1 },
      { conversationId: 'a', score: 0.1 },
      { conversationId: 'b', score: 0.9 },
    ];
    // a has 2 hits, b has 1 → a first despite b's higher single score.
    expect(rankL3Sessions(anchors, { max: 3 })).toEqual(['a', 'b']);
  });

  it('breaks density ties by summed score, then id', () => {
    const anchors: L3SessionAnchor[] = [
      { conversationId: 'a', score: 0.2 },
      { conversationId: 'b', score: 0.8 },
    ];
    expect(rankL3Sessions(anchors, { max: 2 })).toEqual(['b', 'a']);
  });

  it('honours the max cap', () => {
    const anchors: L3SessionAnchor[] = [
      { conversationId: 'a', score: 0.3 },
      { conversationId: 'b', score: 0.2 },
      { conversationId: 'c', score: 0.1 },
    ];
    expect(rankL3Sessions(anchors, { max: 2 })).toEqual(['a', 'b']);
  });

  it('prefers sessions overlapping the query window (rank-only)', () => {
    const anchors: L3SessionAnchor[] = [
      // b is denser but out of window; a is in window.
      { conversationId: 'a', score: 0.1, atMs: 1500 },
      { conversationId: 'b', score: 0.5, atMs: 50 },
      { conversationId: 'b', score: 0.5, atMs: 60 },
    ];
    const out = rankL3Sessions(anchors, {
      max: 2,
      window: { fromMs: 1000, toMs: 2000 },
    });
    expect(out[0]).toBe('a'); // in-window wins over denser out-of-window
    expect(out).toContain('b'); // preference, not a filter
  });
});

describe('verifierPasses + estimateTokens', () => {
  it('passes only on supported (and answering under topic coverage)', () => {
    expect(verifierPasses({ verdict: 'supported' }, false)).toBe(true);
    expect(verifierPasses({ verdict: 'partial' }, false)).toBe(false);
    expect(verifierPasses({ verdict: 'supported', questionAnswered: false }, true)).toBe(false);
    expect(verifierPasses({ verdict: 'supported', questionAnswered: true }, true)).toBe(true);
  });

  it('estimates tokens as chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

// ── service: orchestration with mocked IO ───────────────────────────
interface Mocks {
  outcomes: string[];
  triggerPaths: string[];
  windowAroundCalls: number;
  conversationTurnsCalls: number;
}

function fakeOpenAi(responses: string[]): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => ({
          id: 'stub',
          choices: [
            {
              message: {
                content: responses[i++] ?? responses[responses.length - 1],
              },
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;
}

function makeProfile(overrides: Partial<RetrievalProfile>): RetrievalProfile {
  return {
    ...resolveRetrievalProfile({}),
    l3Escalation: true,
    l3MaxSessions: 3,
    l3TokenCap: 60000,
    abstentionMinTopScore: 0.35,
    abstentionMinEvidence: 2,
    verifierTopicCoverage: false,
    searchLoop: false,
    rawWindowSpan: 2,
    ...overrides,
  };
}

function makeService(opts: {
  factEps: Array<{ id: string; eps: string[] }>;
  episodesByIds: Array<{ id: string; conversationId: string; occurredAt: string }>;
  sessionTurns: Record<
    string,
    Array<{ id: string; speaker: string; text: string; occurredAt: string }>
  >;
  windowTurns?: Array<{ id: string; speaker: string; text: string; occurredAt: string }>;
}): { service: L3EscalationService; mocks: Mocks } {
  const mocks: Mocks = {
    outcomes: [],
    triggerPaths: [],
    windowAroundCalls: 0,
    conversationTurnsCalls: 0,
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) =>
      fn({ query: async () => [opts.factEps] }),
  } as unknown as SurrealService;
  const episodes = {
    byIds: async () => opts.episodesByIds,
    conversationTurns: async (a: { conversationId: string }) => {
      mocks.conversationTurnsCalls += 1;
      return opts.sessionTurns[a.conversationId] ?? [];
    },
    windowAround: async () => {
      mocks.windowAroundCalls += 1;
      return opts.windowTurns ?? [];
    },
  } as unknown as EpisodeReadStoreService;
  const metrics = {
    countL3Escalation: (o: string) => mocks.outcomes.push(o),
    countL3TriggerPath: (p: string) => mocks.triggerPaths.push(p),
    recordOpenAiCall: () => {},
  } as unknown as MetricsService;
  return { service: new L3EscalationService(surreal, episodes, metrics), mocks };
}

const FACT_ID = 'knowledge_fact:f1';

function oneFactResults(score: number): SearchHit[] {
  return [
    {
      entityId: 'knowledge_entity:e1',
      entityType: 'topic',
      canonicalName: 'tier',
      externalRefs: {},
      facts: [
        {
          factId: FACT_ID,
          predicate: 'tier',
          object: 'sapphire',
          confidence: 0.9,
          validFrom: '2026-04-01T00:00:00Z',
          status: 'active',
          score,
        },
      ],
      score,
    },
  ];
}

function factIndexOf(): Map<string, Citation> {
  return new Map([
    [
      FACT_ID,
      {
        factId: FACT_ID,
        entityId: 'knowledge_entity:e1',
        canonicalName: 'tier',
        predicate: 'tier',
        object: 'sapphire',
      },
    ],
  ]);
}

function baseInput(openai: OpenAI, profile: RetrievalProfile) {
  return {
    openai,
    model: 'gpt-4o-mini',
    companyId: 'co1',
    dto: { query: 'what tier?' } as SynthesizeDto,
    callerScopes: ['brain:read'],
    profile,
    lane: null,
    verdict: { verdict: 'unsupported' } as VerifierOutput,
    refineAttempted: false,
    escalated: false,
    results: oneFactResults(0.1),
    factIndex: factIndexOf(),
    factLines: [`[${FACT_ID}] tier (topic) — tier: sapphire`],
    answerLang: null,
  };
}

describe('L3EscalationService.escalate', () => {
  it('fires and flips: returns the L3 answer, counts fired+flipped', async () => {
    const { service, mocks } = makeService({
      factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
      episodesByIds: [
        { id: 'episode:ep1', conversationId: 'conv1', occurredAt: '2026-04-01T00:00:00Z' },
      ],
      sessionTurns: {
        conv1: [
          {
            id: 'episode:ep1',
            speaker: 'user',
            text: 'my tier is sapphire',
            occurredAt: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    const openai = fakeOpenAi([
      JSON.stringify({ answer: 'The tier is sapphire.', citedFactIds: [FACT_ID] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const out = await service.escalate(baseInput(openai, makeProfile({})));
    expect(out?.answer).toBe('The tier is sapphire.');
    expect(out?.verdict.verdict).toBe('supported');
    expect(out?.citations.map((c) => c.factId)).toEqual([FACT_ID]);
    expect(mocks.outcomes).toEqual(['fired', 'flipped']);
    expect(mocks.conversationTurnsCalls).toBe(1);
    expect(mocks.windowAroundCalls).toBe(0);
  });

  it('fired but verifier still fails → no_flip, returns null', async () => {
    const { service, mocks } = makeService({
      factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
      episodesByIds: [
        { id: 'episode:ep1', conversationId: 'conv1', occurredAt: '2026-04-01T00:00:00Z' },
      ],
      sessionTurns: {
        conv1: [
          {
            id: 'episode:ep1',
            speaker: 'user',
            text: 'unrelated chatter',
            occurredAt: '2026-04-01T00:00:00Z',
          },
        ],
      },
    });
    const openai = fakeOpenAi([
      JSON.stringify({ answer: 'A guess.', citedFactIds: [] }),
      JSON.stringify({ verdict: 'unsupported', unsupportedClaims: ['A guess.'] }),
    ]);
    const out = await service.escalate(baseInput(openai, makeProfile({})));
    expect(out).toBeNull();
    expect(mocks.outcomes).toEqual(['fired', 'no_flip']);
  });

  it('no anchoring session → skipped_no_anchor, no generation', async () => {
    const { service, mocks } = makeService({
      factEps: [], // no grounding stamps resolve
      episodesByIds: [],
      sessionTurns: {},
    });
    const openai = fakeOpenAi(['{}']);
    const out = await service.escalate(baseInput(openai, makeProfile({})));
    expect(out).toBeNull();
    expect(mocks.outcomes).toEqual(['skipped_no_anchor']);
    expect(mocks.conversationTurnsCalls).toBe(0);
  });

  it('already-escalated → straight to abstain, no IO, no metrics', async () => {
    const { service, mocks } = makeService({
      factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
      episodesByIds: [
        { id: 'episode:ep1', conversationId: 'conv1', occurredAt: '2026-04-01T00:00:00Z' },
      ],
      sessionTurns: { conv1: [] },
    });
    const openai = fakeOpenAi(['{}']);
    const out = await service.escalate({
      ...baseInput(openai, makeProfile({})),
      escalated: true,
    });
    expect(out).toBeNull();
    expect(mocks.outcomes).toEqual([]);
  });

  it('over budget → degrades to widened L2 windows', async () => {
    const bigText = 'x'.repeat(2000); // > tiny token cap once assembled
    const { service, mocks } = makeService({
      factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
      episodesByIds: [
        { id: 'episode:ep1', conversationId: 'conv1', occurredAt: '2026-04-01T00:00:00Z' },
      ],
      sessionTurns: {
        conv1: [
          { id: 'episode:ep1', speaker: 'user', text: bigText, occurredAt: '2026-04-01T00:00:00Z' },
        ],
      },
      windowTurns: [
        {
          id: 'episode:ep1',
          speaker: 'user',
          text: 'tier is sapphire',
          occurredAt: '2026-04-01T00:00:00Z',
        },
      ],
    });
    const openai = fakeOpenAi([
      JSON.stringify({ answer: 'sapphire', citedFactIds: [FACT_ID] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const out = await service.escalate(baseInput(openai, makeProfile({ l3TokenCap: 10 })));
    expect(out?.answer).toBe('sapphire');
    expect(mocks.outcomes).toEqual(['fired', 'over_budget_degraded', 'flipped']);
    expect(mocks.windowAroundCalls).toBeGreaterThan(0);
  });

  it('flag off → escalate returns null without touching IO', async () => {
    const { service, mocks } = makeService({
      factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
      episodesByIds: [],
      sessionTurns: {},
    });
    const openai = fakeOpenAi(['{}']);
    const out = await service.escalate(baseInput(openai, makeProfile({ l3Escalation: false })));
    expect(out).toBeNull();
    expect(mocks.outcomes).toEqual([]);
  });

  // ── Optics-2 adaptive path (§4.1) ─────────────────────────────────
  // A flat single-bucket map → applyMap returns `value` for ANY raw
  // confidence, so the calibrated confidence is deterministic in tests.
  const flatCalibration = (value: number): PerClassCalibration => ({
    default: { thresholds: [1], values: [value], sampleCount: 100 },
  });

  const oneFactSetup = () => ({
    factEps: [{ id: FACT_ID, eps: ['episode:ep1'] }],
    episodesByIds: [
      { id: 'episode:ep1', conversationId: 'conv1', occurredAt: '2026-04-01T00:00:00Z' },
    ],
    sessionTurns: {
      conv1: [
        {
          id: 'episode:ep1',
          speaker: 'user',
          text: 'my tier is sapphire',
          occurredAt: '2026-04-01T00:00:00Z',
        },
      ],
    },
  });

  const flipScript = () =>
    fakeOpenAi([
      JSON.stringify({ answer: 'The tier is sapphire.', citedFactIds: [FACT_ID] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);

  it('no model supplied → the STATIC path, byte-identical fire+flip (safety)', async () => {
    // adaptiveL3 absent ⇒ the service must reproduce today's static
    // decision exactly, and label the fired trigger 'static'.
    const { service, mocks } = makeService(oneFactSetup());
    const out = await service.escalate(baseInput(flipScript(), makeProfile({})));
    expect(out?.answer).toBe('The tier is sapphire.');
    expect(mocks.outcomes).toEqual(['fired', 'flipped']);
    expect(mocks.triggerPaths).toEqual(['static']);
  });

  it('adaptive + low confidence → fires via the ADAPTIVE path, flips', async () => {
    const { service, mocks } = makeService(oneFactSetup());
    const out = await service.escalate({
      ...baseInput(flipScript(), makeProfile({})),
      adaptiveL3: { calibration: flatCalibration(0.1), threshold: 0.5 },
    });
    expect(out?.answer).toBe('The tier is sapphire.');
    expect(mocks.outcomes).toEqual(['fired', 'flipped']);
    expect(mocks.triggerPaths).toEqual(['adaptive']);
  });

  it('adaptive + high confidence → skip_confident, suppresses a fire the static floor WOULD have made', async () => {
    // results score 0.1 is below the coverage floor, so the static path
    // fires here — but a calibrated confidence of 0.9 (≥ 0.5) suppresses
    // it. Confidence REPLACES coverage: no generation, no metrics, no IO.
    const { service, mocks } = makeService(oneFactSetup());
    const out = await service.escalate({
      ...baseInput(fakeOpenAi(['{}']), makeProfile({})),
      adaptiveL3: { calibration: flatCalibration(0.9), threshold: 0.5 },
    });
    expect(out).toBeNull();
    expect(mocks.outcomes).toEqual([]);
    expect(mocks.triggerPaths).toEqual([]);
    expect(mocks.conversationTurnsCalls).toBe(0);
  });

  it('adaptive depth scaling: near-threshold confidence narrows #sessions below the static cap', async () => {
    const threeSessions = {
      factEps: [
        { id: 'knowledge_fact:a', eps: ['episode:ea'] },
        { id: 'knowledge_fact:b', eps: ['episode:eb'] },
        { id: 'knowledge_fact:c', eps: ['episode:ec'] },
      ],
      episodesByIds: [
        { id: 'episode:ea', conversationId: 'ca', occurredAt: '2026-04-01T00:00:00Z' },
        { id: 'episode:eb', conversationId: 'cb', occurredAt: '2026-04-01T00:00:00Z' },
        { id: 'episode:ec', conversationId: 'cc', occurredAt: '2026-04-01T00:00:00Z' },
      ],
      sessionTurns: {
        ca: [
          { id: 'episode:ea', speaker: 'user', text: 'tier a', occurredAt: '2026-04-01T00:00:00Z' },
        ],
        cb: [
          { id: 'episode:eb', speaker: 'user', text: 'tier b', occurredAt: '2026-04-01T00:00:00Z' },
        ],
        cc: [
          { id: 'episode:ec', speaker: 'user', text: 'tier c', occurredAt: '2026-04-01T00:00:00Z' },
        ],
      },
    };
    const threeResults: SearchHit[] = [
      { factId: 'knowledge_fact:a', score: 0.3 },
      { factId: 'knowledge_fact:b', score: 0.2 },
      { factId: 'knowledge_fact:c', score: 0.1 },
    ].map((s, i) => ({
      entityId: `knowledge_entity:e${i}`,
      entityType: 'topic',
      canonicalName: 'tier',
      externalRefs: {},
      facts: [
        {
          factId: s.factId,
          predicate: 'tier',
          object: 'sapphire',
          confidence: 0.9,
          validFrom: '2026-04-01T00:00:00Z',
          status: 'active',
          score: s.score,
        },
      ],
      score: s.score,
    }));

    // Static baseline (no model): uses the full l3MaxSessions=3 cap.
    {
      const { service, mocks } = makeService(threeSessions);
      await service.escalate({
        ...baseInput(flipScript(), makeProfile({ l3MaxSessions: 3 })),
        results: threeResults,
      });
      expect(mocks.conversationTurnsCalls).toBe(3);
    }

    // Adaptive: confidence 0.45 just below the 0.5 threshold → deficit 0.1
    // → ceil(0.1·3)=1 session, even though 3 anchors are available.
    {
      const { service, mocks } = makeService(threeSessions);
      await service.escalate({
        ...baseInput(flipScript(), makeProfile({ l3MaxSessions: 3 })),
        results: threeResults,
        adaptiveL3: { calibration: flatCalibration(0.45), threshold: 0.5 },
      });
      expect(mocks.triggerPaths).toEqual(['adaptive']);
      expect(mocks.conversationTurnsCalls).toBe(1);
    }
  });
});
