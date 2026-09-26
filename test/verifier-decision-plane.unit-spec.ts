import { runVerifier } from '../src/synthesize/verifier';
import type { DecisionService } from '../src/ai/decisions/decision.service';
import type { DecisionResponse } from '../src/ai/decisions/decision.types';

/**
 * The verifier's cheap first pass. Its one job is to CLEAR an answer the
 * evidence plainly supports; it must never condemn one, and never wave one
 * through on a shaky decision — the auditor is the only call that can name the
 * offending spans, and a contested answer is exactly when those are worth
 * paying for.
 */
const decisionsStub = (opts: {
  enabled?: boolean;
  res?: DecisionResponse | null;
  floor?: number;
}): DecisionService =>
  ({
    enabled: () => opts.enabled !== false,
    decide: async () => opts.res ?? null,
    floorFor: () => opts.floor ?? 0.7,
    confident: (_lane: string, a: { type: string; noul?: number; confidence?: number }) =>
      (a.type === 'noul' ? Math.abs((a.noul ?? 0) - 0.5) * 2 : (a.confidence ?? 0)) >=
      (opts.floor ?? 0.7),
  }) as unknown as DecisionService;

const choice = (c: string, confidence: number): DecisionResponse => ({
  model: 'jev-1.13.0',
  answers: {
    grounding: { type: 'choice', choice: c, probabilities: { [c]: confidence }, confidence },
  },
  usage: { inputTokens: 10, outputTokens: 0 },
});

/** An OpenAI double that records whether the auditor was actually called. */
function auditorDouble(verdict = 'partial', questionAnswered?: boolean) {
  const calls: unknown[] = [];
  const openai = {
    chat: {
      completions: {
        create: async (body: unknown) => {
          calls.push(body);
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict,
                    unsupportedClaims: ['a claim'],
                    ...(questionAnswered === undefined ? {} : { questionAnswered }),
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
  return { openai, calls };
}

const baseReq = (extra: Record<string, unknown>) =>
  ({
    query: 'where does Sasha live?',
    answer: 'Sasha lives in Braga. [f1]',
    factLines: ['[f1] moved_to: Braga'],
    model: 'gpt-6-luna',
    ...extra,
  }) as Parameters<typeof runVerifier>[0];

describe('verifier — the decision plane first pass', () => {
  it('clears a supported answer without calling the auditor', async () => {
    const { openai, calls } = auditorDouble();
    const out = await runVerifier(
      baseReq({ openai, decisions: decisionsStub({ res: choice('supported', 0.93) }) }),
    );
    expect(out).toEqual({ verdict: 'supported', unsupportedClaims: [] });
    expect(calls).toHaveLength(0);
  });

  it('escalates when the decision is below the floor', async () => {
    const { openai, calls } = auditorDouble('partial');
    const out = await runVerifier(
      baseReq({ openai, decisions: decisionsStub({ res: choice('supported', 0.55) }) }),
    );
    expect(out.verdict).toBe('partial');
    expect(calls).toHaveLength(1);
  });

  it('never condemns on its own — a "partial" hunch goes to the auditor', async () => {
    const { openai, calls } = auditorDouble('supported');
    const out = await runVerifier(
      baseReq({ openai, decisions: decisionsStub({ res: choice('partial', 0.99) }) }),
    );
    expect(out.verdict).toBe('supported');
    expect(calls).toHaveLength(1);
  });

  it('falls through when the lane is off or the plane answered nothing', async () => {
    const off = auditorDouble('unsupported');
    await runVerifier(
      baseReq({ openai: off.openai, decisions: decisionsStub({ enabled: false }) }),
    );
    expect(off.calls).toHaveLength(1);

    const silent = auditorDouble('unsupported');
    await runVerifier(baseReq({ openai: silent.openai, decisions: decisionsStub({ res: null }) }));
    expect(silent.calls).toHaveLength(1);
  });

  it('carries the coverage judgement, and escalates when it is missing', async () => {
    const answered: DecisionResponse = {
      ...choice('supported', 0.95),
      answers: {
        ...choice('supported', 0.95).answers,
        question_answered: { type: 'noul', noul: 0.88 },
      },
    };
    const cleared = auditorDouble();
    const out = await runVerifier(
      baseReq({
        openai: cleared.openai,
        topicCoverage: true,
        decisions: decisionsStub({ res: answered }),
      }),
    );
    expect(out).toEqual({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true });
    expect(cleared.calls).toHaveLength(0);

    // Coverage asked for but not answered ⇒ the audit is incomplete ⇒ escalate.
    const missing = auditorDouble('supported', true);
    await runVerifier(
      baseReq({
        openai: missing.openai,
        topicCoverage: true,
        decisions: decisionsStub({ res: choice('supported', 0.95) }),
      }),
    );
    expect(missing.calls).toHaveLength(1);
  });

  it('evidence about a similar but different subject does not answer the question', async () => {
    const swapped = {
      ...choice('supported', 0.95),
      answers: {
        ...choice('supported', 0.95).answers,
        question_answered: { type: 'noul' as const, noul: 0.8 },
        same_subject: { type: 'noul' as const, noul: 0.1 },
      },
    };
    const out = await runVerifier(
      baseReq({
        openai: auditorDouble().openai,
        topicCoverage: true,
        decisions: decisionsStub({ res: swapped }),
      }),
    );
    expect(out).toMatchObject({ verdict: 'supported', questionAnswered: false });
  });
});
