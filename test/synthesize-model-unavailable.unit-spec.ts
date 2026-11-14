/**
 * #945 phase 1: synthesize never masks a provider outage.
 *
 * On 2026-11-13 the provider answered 402; `synthesize` returned
 * `verifier_failed` (strict) and "I don't have that in my memory"
 * (lenient + verifier abstention). These pin both halves of the fix: a
 * verdict reached while the audit was refused exits `model_unavailable`
 * with `degraded` + `notice` in every guardrail mode, and a GENUINE
 * unsupported verdict keeps today's exact behaviour.
 */
import type OpenAI from 'openai';
import { finalizeVerdict } from '../src/synthesize/verdict';
import { verifyAndZoom, type VerifyStageArgs } from '../src/synthesize/fragment-zoom-seam';
import { modelUnavailableResult } from '../src/synthesize/model-unavailable';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import { SERVER_MODELS_NOTICE } from '../src/ai/provider-failure';
import { resetProviderHealth, withProviderFailureScope } from '../src/ai/provider-health';
import { HarnessModeRefusal } from '../src/common/extraction-source';
import type { Citation } from '../src/synthesize/fact-index';
import type { SynthesisGuardrails } from '../src/synthesize/dto/synthesize.dto';
import type { RetrievalProfile } from '../src/search/retrieval-profile';

const CITE: Citation = {
  factId: 'knowledge_fact:f1',
  entityId: 'knowledge_entity:e1',
  canonicalName: 'Alex',
  predicate: 'works_at',
  slot: 'works_at',
  object: 'Acme',
};
const ANSWER = 'Alex works at Acme [f1].';

function verdictArgs(
  guardrails: SynthesisGuardrails,
  extra: Partial<Parameters<typeof finalizeVerdict>[1]> = {},
): Parameters<typeof finalizeVerdict>[1] {
  return {
    verdict: 'unsupported',
    answer: ANSWER,
    citations: [CITE],
    results: [],
    guardrails,
    ...extra,
  };
}

function counting() {
  const outcomes: string[] = [];
  return {
    outcomes,
    deps: {
      metrics: {
        countSynthesize: (o: string) => outcomes.push(o),
      } as never,
    },
  };
}

describe('finalizeVerdict — a genuine unsupported verdict is unchanged', () => {
  it('strict: verifier_failed, answer dropped', () => {
    const out = finalizeVerdict({}, verdictArgs('strict'));
    expect(out).toEqual({ answer: null, reason: 'verifier_failed', citations: [], results: [] });
  });

  it('strict partial: verifier_partial, answer dropped', () => {
    const out = finalizeVerdict({}, verdictArgs('strict', { verdict: 'partial' }));
    expect(out).toEqual({ answer: null, reason: 'verifier_partial', citations: [], results: [] });
  });

  it('lenient: the answer with verifier_failed', () => {
    const out = finalizeVerdict({}, verdictArgs('lenient'));
    expect(out).toEqual({
      answer: ANSWER,
      reason: 'verifier_failed',
      citations: [CITE],
      results: [],
    });
  });

  it.each(['verifier', 'minicheck'] as const)(
    'lenient + %s abstention: the explicit decline (low_coverage)',
    (abstention) => {
      const out = finalizeVerdict({}, verdictArgs('lenient', { abstention }));
      expect(out).toEqual({
        answer: NOT_IN_MEMORY_ANSWER,
        reason: 'low_coverage',
        citations: [],
        results: [],
      });
    },
  );

  it('verifierUnavailable=false is byte-identical to absent', () => {
    for (const g of ['strict', 'lenient'] as const) {
      expect(finalizeVerdict({}, verdictArgs(g, { verifierUnavailable: false }))).toEqual(
        finalizeVerdict({}, verdictArgs(g)),
      );
    }
  });

  it('a supported verdict serves even when part of the audit was refused', () => {
    const out = finalizeVerdict(
      {},
      verdictArgs('strict', { verdict: 'supported', verifierUnavailable: true }),
    );
    expect(out).toEqual({ answer: ANSWER, citations: [CITE], results: [] });
  });
});

describe('finalizeVerdict — a verdict reached while the audit was refused', () => {
  it('strict: model_unavailable, answer null, degraded verifier, the notice', () => {
    const { deps, outcomes } = counting();
    const out = finalizeVerdict(deps, verdictArgs('strict', { verifierUnavailable: true }));
    expect(out).toEqual({
      answer: null,
      reason: 'model_unavailable',
      citations: [],
      results: [],
      degraded: ['verifier'],
      notice: SERVER_MODELS_NOTICE,
    });
    expect(outcomes).toEqual(['model_unavailable']);
  });

  it('lenient: the unchecked answer with its citations, never the not-in-memory text', () => {
    const out = finalizeVerdict({}, verdictArgs('lenient', { verifierUnavailable: true }));
    expect(out).toEqual({
      answer: ANSWER,
      reason: 'model_unavailable',
      citations: [CITE],
      results: [],
      degraded: ['verifier'],
      notice: SERVER_MODELS_NOTICE,
    });
  });

  it.each(['verifier', 'minicheck', 'coverage', 'off'] as const)(
    'lenient + %s abstention: still model_unavailable (the incident shape)',
    (abstention) => {
      const out = finalizeVerdict(
        {},
        verdictArgs('lenient', { abstention, verifierUnavailable: true }),
      );
      expect(out.reason).toBe('model_unavailable');
      expect(out.answer).toBe(ANSWER);
      expect(out.answer).not.toBe(NOT_IN_MEMORY_ANSWER);
    },
  );

  it('partial counts the same as unsupported', () => {
    const out = finalizeVerdict(
      {},
      verdictArgs('strict', { verdict: 'partial', verifierUnavailable: true }),
    );
    expect(out.reason).toBe('model_unavailable');
  });

  it('carries the decision log', () => {
    const decisionLog = [{ factId: 'knowledge_fact:f1' }] as never;
    const out = finalizeVerdict(
      {},
      verdictArgs('strict', { verifierUnavailable: true, decisionLog }),
    );
    expect(out.decisionLog).toBe(decisionLog);
  });
});

describe('modelUnavailableResult — generator stage', () => {
  it.each(['strict', 'lenient', 'off', 'answer'] as const)(
    '%s: no answer, degraded generator, the notice',
    (guardrails) => {
      const out = modelUnavailableResult(undefined, {
        stage: 'generator',
        guardrails,
        answer: null,
        citations: [],
        results: [],
      });
      expect(out).toEqual({
        answer: null,
        reason: 'model_unavailable',
        citations: [],
        results: [],
        degraded: ['generator'],
        notice: SERVER_MODELS_NOTICE,
      });
    },
  );
});

describe('verifyAndZoom — the verifier call itself is refused', () => {
  beforeEach(() => resetProviderHealth());

  function refusingOpenAi(err: unknown): OpenAI {
    return {
      chat: {
        completions: {
          create: async () => {
            throw err;
          },
        },
      },
    } as unknown as OpenAI;
  }

  function stage(openai: OpenAI, guardrails: SynthesisGuardrails) {
    const warns: string[] = [];
    const outcomes: string[] = [];
    const deps = {
      openai,
      metrics: {
        countSynthesize: (o: string) => outcomes.push(o),
        recordOpenAiCall: () => undefined,
      } as never,
      logger: { warn: (m: string) => warns.push(m) },
      limiter: { run: <T>(fn: () => Promise<T>) => fn() },
      minicheck: { baseUrl: 'http://127.0.0.1:1', model: 'm' },
    };
    const args: VerifyStageArgs = {
      ctx: {
        companyId: 'co_test',
        dto: { query: 'where does Alex work?' } as never,
        callerScopes: ['brain:read'],
        profile: { abstentionCalibration: 'verifier' } as unknown as RetrievalProfile,
        model: 'gpt-test',
        guardrails,
      },
      generated: { answer: ANSWER, citedFactIds: ['f1'] },
      collected: {
        fragmentLines: [],
        fragmentZoom: [],
        transcriptLines: [],
        insightLines: [],
        beliefLines: [],
        sceneLines: [],
        timelineEvidence: false,
      },
      promptFactLines: ['[knowledge_fact:f1] Alex — works_at: Acme'],
      citations: [CITE],
      results: [],
      decisionLog: undefined,
      factCount: 1,
      decisionCtx: { t0: 0 },
      onPrimaryVerdict: async () => undefined,
    };
    return { deps, args, warns, outcomes };
  }

  const billing = Object.assign(new Error('402 Insufficient credits'), { status: 402 });

  it('strict: model_unavailable with no answer, and the scope learns why', async () => {
    const { deps, args, outcomes, warns } = stage(refusingOpenAi(billing), 'strict');
    const { value, failures } = await withProviderFailureScope(() => verifyAndZoom(deps, args));
    expect('failed' in value && value.failed).toEqual({
      answer: null,
      reason: 'model_unavailable',
      citations: [],
      results: [],
      degraded: ['verifier'],
      notice: SERVER_MODELS_NOTICE,
    });
    expect(outcomes).toEqual(['model_unavailable']);
    expect(failures).toEqual([{ capability: 'chat', cls: 'billing' }]);
    // The class is logged; the answer never is.
    expect(warns.join('\n')).toContain('billing');
    expect(warns.join('\n')).not.toContain('Acme');
  });

  it('lenient: the unchecked answer, tagged', async () => {
    const { deps, args } = stage(refusingOpenAi(billing), 'lenient');
    const out = await verifyAndZoom(deps, args);
    expect('failed' in out && out.failed).toMatchObject({
      answer: ANSWER,
      reason: 'model_unavailable',
      citations: [CITE],
      degraded: ['verifier'],
    });
  });

  it('a verifier failure that is not the provider keeps verifier_error', async () => {
    const { deps, args, outcomes } = stage(refusingOpenAi(new Error('bad json')), 'strict');
    const out = await verifyAndZoom(deps, args);
    expect('failed' in out && out.failed).toEqual({
      answer: null,
      reason: 'verifier_error',
      citations: [],
      results: [],
    });
    expect(outcomes).toEqual(['verifier_error']);
  });

  it('a harness refusal is not a provider outage', async () => {
    const { deps, args } = stage(refusingOpenAi(new HarnessModeRefusal()), 'strict');
    const out = await verifyAndZoom(deps, args);
    expect('failed' in out && out.failed && out.failed.reason).toBe('verifier_error');
  });
});
