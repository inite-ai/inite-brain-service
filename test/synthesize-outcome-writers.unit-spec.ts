/**
 * 0107 outcome-telemetry writer seams inside SynthesizeService, driven
 * with a mocked MemoryOutcomeService (no DB, no OpenAI):
 *   * selected_for_context fires once, after produceAnswer returns, for
 *     the FINAL factIndex keys;
 *   * used_in_answer + verifier_supported (meta { verdict }) fire in
 *     finalizeAndAdmit on a supported strict verdict;
 *   * the unverifiedReturn exit ('answer'/'off' guardrails) emits
 *     used_in_answer for the served citations — and NEVER
 *     verifier_supported (no verifier ran);
 *   * with the master flag off, nothing is emitted at any seam.
 *
 * Plus the 0119 wave seams:
 *   * the flag-free serving-boundary latency observe — EXACTLY ONE
 *     observeSearchDuration() per synthesize() call, including the
 *     no_results and thrown-error exits (the `finally` contract);
 *   * the OUTCOME_DECISION_CAPTURE abstain writer + primary-decision-id
 *     threading onto the emitAnswerUse events.
 */
import { ConfigService } from '@nestjs/config';
import { SynthesizeService } from '../src/synthesize/synthesize.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type { MetricsService } from '../src/metrics/metrics.service';
import { getActiveRetrievalProfile } from '../src/search/retrieval-profile';
import type {
  MemoryOutcomeService,
  OutcomeEventInput,
} from '../src/outcomes/memory-outcome.service';
import type { DecisionInput, MemoryDecisionService } from '../src/outcomes/memory-decision.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { AnswerCacheService } from '../src/answer-cache/answer-cache.service';

interface RecordedCall {
  companyId: string;
  events: OutcomeEventInput[];
}

function makeHit(entityId: string, factId: string): SearchHit {
  return {
    entityId,
    entityType: 'customer',
    canonicalName: entityId,
    externalRefs: {},
    facts: [
      {
        factId,
        predicate: 'name',
        object: 'Maya',
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00Z',
        status: 'active',
        score: 0.5,
      },
    ],
    score: 0.5,
  } as SearchHit;
}

function makeConfig(): ConfigService {
  return {
    get: <T>(_k: string, dflt?: T) => dflt as T,
    getOrThrow: <T>() => 'sk-stub' as unknown as T,
  } as unknown as ConfigService;
}

/** Generator answers with a citation; the verifier (system prompt names
 *  the auditor role) returns the requested verdict. */
function stubOpenAI(verdict: string, citedId = 'f1') {
  return {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          const isVerifier = req.messages[0]!.content.includes('auditor');
          return {
            choices: [
              {
                message: {
                  content: isVerifier
                    ? JSON.stringify({ verdict })
                    : JSON.stringify({ answer: `Maya [${citedId}].`, citedFactIds: [citedId] }),
                },
                finish_reason: 'stop',
              },
            ],
          };
        },
      },
    },
  };
}

interface DecisionCall {
  companyId: string;
  input: DecisionInput;
}

function makeSvc(
  verdict: string,
  opts: {
    metrics?: MetricsService | undefined;
    decisionCalls?: DecisionCall[] | undefined;
    searchImpl?: (() => Promise<{ results: SearchHit[] }>) | undefined;
    /** The hit's fact id (and what the generator cites); a `table:key` id
     *  is needed for the 0115 grounding fetch to consider it at all. */
    factId?: string | undefined;
    /** 0115 grounding fetch port source — a stub whose withCompany
     *  answers the `SELECT id, groundingStatus` read. */
    surreal?: SurrealService | undefined;
    answerCache?: AnswerCacheService | undefined;
  } = {},
): { svc: SynthesizeService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const outcomes = {
    recordOutcomes: (o: RecordedCall) => {
      calls.push({ companyId: o.companyId, events: o.events });
    },
  } as unknown as MemoryOutcomeService;
  const decisions = opts.decisionCalls
    ? ({
        record: (companyId: string, input: DecisionInput) => {
          opts.decisionCalls!.push({ companyId, input });
          // Distinct per kind so the primary-decision slot is checkable:
          // the id threaded onto the outcome rows must be the decision
          // that explains the ANSWER, never the lane_route row that fires
          // before it or the verdict row that fires after.
          return input.decisionKind === 'abstain' || input.decisionKind === 'l3_escalation'
            ? 'deadbeefdeadbeefdeadbeefdeadbeef'
            : `0119${input.decisionKind.padEnd(28, '0').slice(0, 28)}`;
        },
      } as unknown as MemoryDecisionService)
    : undefined;
  const factId = opts.factId ?? 'f1';
  const search = {
    search: opts.searchImpl ?? (async () => ({ results: [makeHit('cust_a', factId)] })),
  } as unknown as SearchService;
  const svc = new SynthesizeService(
    search,
    makeConfig(),
    opts.metrics, // metrics
    undefined, // evidenceCollector
    opts.answerCache, // answerCache
    undefined, // l3
    undefined, // focusSignal
    undefined, // lensSuppression
    undefined, // laneClassifier
    outcomes,
    undefined, // predicateRegistry
    opts.surreal, // surreal (0115 grounding fetch)
    decisions,
  );
  (svc as unknown as { openai: unknown }).openai = stubOpenAI(verdict, factId);
  return { svc, calls };
}

const eventsOf = (calls: RecordedCall[]) => calls.flatMap((c) => c.events);
const named = (calls: RecordedCall[], event: string) =>
  eventsOf(calls).filter((e) => e.event === event);

const baseDto: SynthesizeDto = { query: 'what is her name?' };

describe('SynthesizeService — 0107 outcome writer seams', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  it('strict + supported: selected_for_context, then used_in_answer + verifier_supported', async () => {
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');

    const selected = named(calls, 'selected_for_context');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ subjectKind: 'fact', subjectId: 'f1' });

    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ subjectId: 'f1' });

    const verified = named(calls, 'verifier_supported');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ subjectId: 'f1', meta: { verdict: 'supported' } });

    expect(calls.every((c) => c.companyId === 'co_x')).toBe(true);
  });

  it('strict + unsupported: nothing was served, so NO used_in_answer and NO verifier_supported (audit F7)', async () => {
    // Strict fails closed on an unsupported verdict (answer: null,
    // citations: []). Before F7 the finalize seam still recorded
    // used_in_answer for the DRAFT's citations — a use that never reached
    // the caller. Usage is now emitted from the FINAL result only.
    const { svc, calls } = makeSvc('unsupported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBeNull();
    expect(named(calls, 'selected_for_context')).toHaveLength(1);
    expect(named(calls, 'used_in_answer')).toHaveLength(0);
    expect(named(calls, 'verifier_supported')).toHaveLength(0);
  });

  it('lenient + partial: the answer IS served (reason-tagged) → used_in_answer, never verifier_supported', async () => {
    // Abstention off: under 'verifier' calibration a lenient partial is the
    // explicit decline (nothing served); with it off the lenient path serves
    // the reason-tagged answer — the served-but-not-verified case.
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    try {
      const { svc, calls } = makeSvc('partial');
      const out = await svc.synthesize({
        companyId: 'co_x',
        dto: { ...baseDto, synthesisGuardrails: 'lenient' },
        callerScopes: ['brain:read'],
      });
      expect(out.answer).toBe('Maya [f1].');
      expect(out.reason).toBe('verifier_partial');
      const used = named(calls, 'used_in_answer');
      expect(used).toHaveLength(1);
      expect(used[0]).toMatchObject({ subjectId: 'f1' });
      expect(named(calls, 'verifier_supported')).toHaveLength(0);
    } finally {
      delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
    }
  });

  it('a supported draft the serving gate downgrades records NOTHING — no used_in_answer, no verifier_supported (audit F7)', async () => {
    // EVIDENCE_UNGROUNDED_SERVING_GATE: every cited fact is ungrounded ⇒
    // the supported verdict is downgraded to an abstention AFTER the
    // verifier said 'supported'. The pre-F7 seam had already counted the
    // draft's citations as verified use by then.
    process.env.EVIDENCE_UNGROUNDED_SERVING_GATE = '1';
    try {
      const surreal = {
        withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) =>
          fn({
            query: async () => [[{ id: 'knowledge_fact:f1', groundingStatus: 'ungrounded' }]],
          }),
      } as unknown as SurrealService;
      const { svc, calls } = makeSvc('supported', { surreal, factId: 'knowledge_fact:f1' });
      const out = await svc.synthesize({
        companyId: 'co_x',
        dto: { ...baseDto, synthesisGuardrails: 'strict' },
        callerScopes: ['brain:read'],
      });
      expect(out.reason).toBe('ungrounded_evidence');
      expect(out.citations).toEqual([]);
      expect(named(calls, 'selected_for_context')).toHaveLength(1);
      expect(named(calls, 'used_in_answer')).toHaveLength(0);
      expect(named(calls, 'verifier_supported')).toHaveLength(0);
    } finally {
      delete process.env.EVIDENCE_UNGROUNDED_SERVING_GATE;
    }
  });

  it('an answer-cache hit is served as-is: counted as ok, no outcome events (read-only accounting)', async () => {
    const counted: string[] = [];
    const metrics = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'countSynthesize' ? (o: string) => counted.push(o) : () => undefined,
      },
    ) as unknown as MetricsService;
    const answerCache = {
      begin: async () => ({
        hit: {
          answer: 'Maya (cached).',
          citations: [
            {
              factId: 'f1',
              entityId: 'cust_a',
              canonicalName: 'cust_a',
              predicate: 'name',
              object: 'Maya',
            },
          ],
          results: [],
          cached: true,
        },
      }),
      admit: async () => undefined,
    } as unknown as AnswerCacheService;
    const { svc, calls } = makeSvc('supported', { metrics, answerCache });
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.cached).toBe(true);
    expect(out.answer).toBe('Maya (cached).');
    expect(counted).toEqual(['ok']);
    // The hit's citations were already counted when the answer was first
    // served and admitted; a re-serve from the cache records nothing.
    expect(calls).toEqual([]);
  });

  it("'answer' guardrails (unverifiedReturn exit): used_in_answer, never verifier_supported", async () => {
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'answer' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(named(calls, 'selected_for_context')).toHaveLength(1);
    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ subjectId: 'f1' });
    // No verifier ran — a use is never a VERIFIED use on this exit.
    expect(named(calls, 'verifier_supported')).toHaveLength(0);
  });

  it('master flag off: no seam emits anything (byte-identical)', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    const { svc, calls } = makeSvc('supported');
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(calls).toEqual([]);
  });
});

// ── 0119: flag-free serving-boundary latency observe ────────────────
describe('SynthesizeService — latency observe (flag-free, D8)', () => {
  function makeMetrics(): { metrics: MetricsService; observed: number[] } {
    const observed: number[] = [];
    // A Proxy stub: observeSearchDuration records, every other metric
    // method is a no-op — so the full serve path (incl. the gen-ai call
    // wrappers) runs without a real MetricsService.
    const metrics = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'observeSearchDuration' ? (s: number) => observed.push(s) : () => undefined,
      },
    ) as unknown as MetricsService;
    return { metrics, observed };
  }

  it('observes exactly once on the served (ok) exit', async () => {
    const { metrics, observed } = makeMetrics();
    const { svc } = makeSvc('supported', { metrics });
    await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeGreaterThanOrEqual(0);
  });

  it('observes exactly once on the no_results early exit', async () => {
    const { metrics, observed } = makeMetrics();
    const { svc } = makeSvc('supported', {
      metrics,
      searchImpl: async () => ({ results: [] }),
    });
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.reason).toBe('no_results');
    expect(observed).toHaveLength(1);
  });

  it('observes exactly once even when the flow throws (finally contract)', async () => {
    const { metrics, observed } = makeMetrics();
    const { svc } = makeSvc('supported', {
      metrics,
      searchImpl: async () => {
        throw new Error('search exploded');
      },
    });
    await expect(
      svc.synthesize({
        companyId: 'co_x',
        dto: { ...baseDto, synthesisGuardrails: 'strict' },
        callerScopes: ['brain:read'],
      }),
    ).rejects.toThrow('search exploded');
    expect(observed).toHaveLength(1);
  });
});

// ── 0119: abstain decision writer + primary-id threading ────────────
describe('SynthesizeService — OUTCOME_DECISION_CAPTURE abstain seam', () => {
  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
    process.env.OUTCOME_DECISION_CAPTURE = '1';
  });
  afterAll(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    delete process.env.OUTCOME_DECISION_CAPTURE;
  });

  const coverageProfile = (over: Record<string, unknown> = {}) => ({
    ...getActiveRetrievalProfile(),
    abstentionCalibration: 'coverage' as const,
    ...over,
  });

  it('an abstained request writes ONE static abstain decision (no outcome events)', async () => {
    const decisionCalls: DecisionCall[] = [];
    const { svc, calls } = makeSvc('supported', { decisionCalls });
    // One fact < the default minEvidence floor (2) → coverage abstain.
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
      profile: coverageProfile({ abstentionMinEvidence: 2 }),
    });
    expect(out.reason).toBe('low_coverage');
    // Three rows, in flow order: route → abstain → verdict.
    expect(decisionCalls.map((c) => c.input.decisionKind)).toEqual([
      'lane_route',
      'abstain',
      'verdict',
    ]);
    const d = decisionCalls[1]!;
    expect(d.companyId).toBe('co_x');
    expect(d.input.chosenAction).toBe('abstain');
    expect(d.input.policyVersion).toBe('static');
    expect(d.input.actionScore).toBeUndefined();
    expect(d.input.observedState).toMatchObject({ candidateCount: 1 });
    expect(typeof d.input.costs?.latencyMs).toBe('number');
    // The verdict row names the exit the caller saw, under its policy.
    expect(decisionCalls[2]!.input.chosenAction).toBe('low_coverage');
    expect(decisionCalls[2]!.input.policyVersion).toBe('verdict@strict/coverage');
    // Abstained pre-generation → no used_in_answer/verifier events.
    expect(calls.flatMap((c) => c.events)).toEqual([]);
  });

  it('a proceed decision threads its id onto the emitAnswerUse events', async () => {
    const decisionCalls: DecisionCall[] = [];
    const { svc, calls } = makeSvc('supported', { decisionCalls });
    // Floors that PASS → 'proceed', then the served flow emits outcomes.
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
      profile: coverageProfile({ abstentionMinEvidence: 1, abstentionMinTopScore: 0 }),
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(decisionCalls.map((c) => c.input.decisionKind)).toEqual([
      'lane_route',
      'abstain',
      'verdict',
    ]);
    expect(decisionCalls[1]!.input.chosenAction).toBe('proceed');
    expect(decisionCalls[2]!.input.chosenAction).toBe('ok');
    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]!.decisionId).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    const verified = named(calls, 'verifier_supported');
    expect(verified[0]!.decisionId).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    // selected_for_context deliberately carries no decision join.
    expect(named(calls, 'selected_for_context')[0]!.decisionId).toBeUndefined();
  });

  // ── 0147: the plane must not be empty on a DEFAULT deployment ──────
  //
  // The regression this pins is the one that shipped: every 0119-era
  // decision writer sits behind a flag that is off out of the box
  // (abstentionCalibration='coverage', RETRIEVAL_L3_ESCALATION,
  // FOVEA_FRAGMENT_ZOOM), so with OUTCOME_DECISION_CAPTURE default-on a
  // live, answering service recorded NOTHING and /stats said
  // `sampled 0`. Note the profile here: the stock one, no overrides.
  it('stock profile (no coverage gate): still records route + verdict', async () => {
    const decisionCalls: DecisionCall[] = [];
    const { svc } = makeSvc('supported', { decisionCalls });
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Maya [f1].');
    expect(decisionCalls.map((c) => c.input.decisionKind)).toEqual(['lane_route', 'verdict']);
    const verdict = decisionCalls[1]!.input;
    expect(verdict.chosenAction).toBe('ok');
    // 'verifier' is what the DEFAULT genre resolves — the abstention
    // mode a stock deployment actually runs, which is NOT the coverage
    // regime the only 0119 abstain writer needs.
    expect(verdict.policyVersion).toBe('verdict@strict/verifier');
    expect(verdict.observedState).toMatchObject({ candidateCount: 1, topScore: 0.5 });
  });

  it('a decline is named by the verdict row, not inferred from its absence', async () => {
    const decisionCalls: DecisionCall[] = [];
    const { svc } = makeSvc('supported', {
      decisionCalls,
      searchImpl: async () => ({ results: [] }),
    });
    const out = await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(out.reason).toBe('no_results');
    // The no_results exit returns BEFORE the abstain seam — it is only
    // covered because the verdict writer sits at the serving boundary.
    expect(decisionCalls.map((c) => c.input.chosenAction)).toEqual(['generic', 'no_results']);
    expect(decisionCalls[1]!.input.observedState).toMatchObject({ candidateCount: 0 });
  });

  it('the lane_route row never claims the primary-decision slot', async () => {
    const decisionCalls: DecisionCall[] = [];
    const { svc, calls } = makeSvc('supported', { decisionCalls });
    await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
      profile: coverageProfile({ abstentionMinEvidence: 1, abstentionMinTopScore: 0 }),
    });
    // Routing fires first; if it claimed the slot, every outcome row
    // would join to a decision that says nothing about the answer.
    expect(named(calls, 'used_in_answer')[0]!.decisionId).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('capture flag off: no decision rows, no decisionId on events (byte-identical)', async () => {
    process.env.OUTCOME_DECISION_CAPTURE = '0';
    const decisionCalls: DecisionCall[] = [];
    const { svc, calls } = makeSvc('supported', { decisionCalls });
    await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
      profile: coverageProfile({ abstentionMinEvidence: 1, abstentionMinTopScore: 0 }),
    });
    expect(decisionCalls).toEqual([]);
    for (const e of calls.flatMap((c) => c.events)) {
      expect(e.decisionId).toBeUndefined();
    }
  });
});
