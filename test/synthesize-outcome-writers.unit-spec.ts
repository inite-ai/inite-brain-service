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
function stubOpenAI(verdict: string) {
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
                    : JSON.stringify({ answer: 'Maya [f1].', citedFactIds: ['f1'] }),
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
          return 'deadbeefdeadbeefdeadbeefdeadbeef';
        },
      } as unknown as MemoryDecisionService)
    : undefined;
  const search = {
    search: opts.searchImpl ?? (async () => ({ results: [makeHit('cust_a', 'f1')] })),
  } as unknown as SearchService;
  const svc = new SynthesizeService(
    search,
    makeConfig(),
    opts.metrics, // metrics
    undefined, // evidenceCollector
    undefined, // answerCache
    undefined, // l3
    undefined, // focusSignal
    undefined, // lensSuppression
    undefined, // laneClassifier
    outcomes,
    undefined, // predicateRegistry
    undefined, // surreal (0115 grounding fetch)
    decisions,
  );
  (svc as unknown as { openai: unknown }).openai = stubOpenAI(verdict);
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

  it('strict + unsupported: used_in_answer still recorded at the finalize seam, NO verifier_supported', async () => {
    const { svc, calls } = makeSvc('unsupported');
    await svc.synthesize({
      companyId: 'co_x',
      dto: { ...baseDto, synthesisGuardrails: 'strict' },
      callerScopes: ['brain:read'],
    });
    expect(named(calls, 'selected_for_context')).toHaveLength(1);
    expect(named(calls, 'used_in_answer')).toHaveLength(1);
    expect(named(calls, 'verifier_supported')).toHaveLength(0);
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
    expect(decisionCalls).toHaveLength(1);
    const d = decisionCalls[0]!;
    expect(d.companyId).toBe('co_x');
    expect(d.input.decisionKind).toBe('abstain');
    expect(d.input.chosenAction).toBe('abstain');
    expect(d.input.policyVersion).toBe('static');
    expect(d.input.actionScore).toBeUndefined();
    expect(d.input.observedState).toMatchObject({ candidateCount: 1 });
    expect(typeof d.input.costs?.latencyMs).toBe('number');
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
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0]!.input.chosenAction).toBe('proceed');
    const used = named(calls, 'used_in_answer');
    expect(used).toHaveLength(1);
    expect(used[0]!.decisionId).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    const verified = named(calls, 'verifier_supported');
    expect(verified[0]!.decisionId).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    // selected_for_context deliberately carries no decision join.
    expect(named(calls, 'selected_for_context')[0]!.decisionId).toBeUndefined();
  });

  it('capture flag off: no decision rows, no decisionId on events (byte-identical)', async () => {
    delete process.env.OUTCOME_DECISION_CAPTURE;
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
