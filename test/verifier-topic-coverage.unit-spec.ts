import { runVerifier } from '../src/synthesize/verifier';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import { SynthesizeService } from '../src/synthesize/synthesize.service';
import type { SearchService } from '../src/search/search.service';
import type { ConfigService } from '@nestjs/config';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V10 §5 — verifier topic-coverage. The V9 abstention residual: 13/40
 * misses were fabrications ASSEMBLED from real facts — every atomic
 * claim individually grounded, the connecting link invented — and the
 * base grounding audit passes them as 'supported'. Under
 * verifierTopicCoverage the auditor treats relationship claims as
 * claims and separately judges whether the evidence answers the query;
 * lenient 'verifier' abstention declines on questionAnswered=false.
 */

interface CapturedRequest {
  system: string;
  schema: {
    properties: Record<string, unknown>;
    required: string[];
  };
  temperature?: number;
  maxCompletionTokens?: number;
}

function mockOpenAi(response: Record<string, unknown>, captured: CapturedRequest[]) {
  return {
    chat: {
      completions: {
        create: async (req: {
          messages: Array<{ role: string; content: string }>;
          response_format: {
            json_schema: { schema: CapturedRequest['schema'] };
          };
          temperature?: number;
          max_completion_tokens?: number;
        }) => {
          captured.push({
            system: req.messages[0]!.content,
            schema: req.response_format.json_schema.schema,
            temperature: req.temperature,
            maxCompletionTokens: req.max_completion_tokens,
          });
          return {
            choices: [
              { message: { content: JSON.stringify(response) }, finish_reason: 'stop' },
            ],
          };
        },
      },
    },
  } as never;
}

const BASE_REQ = {
  query: 'why did Alex switch runtimes?',
  answer: 'Because the token bucket overflowed.',
  factLines: ['[knowledge_fact:f1] Alex — activities: uses a token bucket'],
  model: 'gpt-test',
};

describe('runVerifier topic-coverage audit (V10 §5)', () => {
  it('off — byte-identical prompt and schema, no questionAnswered', async () => {
    const captured: CapturedRequest[] = [];
    const out = await runVerifier({
      ...BASE_REQ,
      openai: mockOpenAi(
        { verdict: 'supported', unsupportedClaims: [] },
        captured,
      ),
    });
    expect(out.verdict).toBe('supported');
    expect(out.questionAnswered).toBeUndefined();
    expect(captured[0]!.system).not.toContain('questionAnswered');
    expect(captured[0]!.schema.properties).not.toHaveProperty('questionAnswered');
    expect(captured[0]!.schema.required).toEqual(['verdict', 'unsupportedClaims']);
  });

  it('on — addendum in the system prompt, questionAnswered in the schema and output', async () => {
    const captured: CapturedRequest[] = [];
    const out = await runVerifier({
      ...BASE_REQ,
      topicCoverage: true,
      openai: mockOpenAi(
        { verdict: 'supported', unsupportedClaims: [], questionAnswered: false },
        captured,
      ),
    });
    expect(out).toMatchObject({ verdict: 'supported', questionAnswered: false });
    // Both tightenings present: relationship claims + the coverage judgment.
    expect(captured[0]!.system).toContain('Relationship claims');
    expect(captured[0]!.system).toContain('questionAnswered');
    expect(captured[0]!.schema.properties).toHaveProperty('questionAnswered');
    expect(captured[0]!.schema.required).toContain('questionAnswered');
  });

  it('reasoning-model judge: no temperature param, widened completion cap', async () => {
    // gpt-5*/o* reject temperature≠1 (400) and bill hidden reasoning
    // against max_completion_tokens — the live V11 §2 failure: 23/40
    // audits degraded to verifier_error under the 256 cap.
    const captured: CapturedRequest[] = [];
    await runVerifier({
      ...BASE_REQ,
      model: 'gpt-5-mini',
      openai: mockOpenAi(
        { verdict: 'supported', unsupportedClaims: [] },
        captured,
      ),
    });
    expect(captured[0]!.temperature).toBeUndefined();
    expect(captured[0]!.maxCompletionTokens).toBe(2048);
    // Non-reasoning models keep the deterministic byte-identical call.
    const classic: CapturedRequest[] = [];
    await runVerifier({
      ...BASE_REQ,
      openai: mockOpenAi(
        { verdict: 'supported', unsupportedClaims: [] },
        classic,
      ),
    });
    expect(classic[0]!.temperature).toBe(0);
    expect(classic[0]!.maxCompletionTokens).toBe(256);
  });

  it('on — a response without the judgment is a contract violation', async () => {
    await expect(
      runVerifier({
        ...BASE_REQ,
        topicCoverage: true,
        openai: mockOpenAi({ verdict: 'supported', unsupportedClaims: [] }, []),
      }),
    ).rejects.toThrow('questionAnswered');
  });
});

describe('finalizeVerdict consumes questionAnswered (V10 §5)', () => {
  function makeService(): SynthesizeService {
    const config = {
      get: (k: string, d?: string) => d,
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const search = {
      search: async () => ({ results: [] }),
    } as unknown as SearchService;
    return new SynthesizeService(search, config);
  }

  type Finalize = (args: {
    verdict: 'supported' | 'partial' | 'unsupported';
    questionAnswered?: boolean;
    answer: string;
    citations: unknown[];
    results: unknown[];
    guardrails: string;
    abstention?: string;
  }) => { answer: string | null; reason?: string };

  const finalize = (svc: SynthesizeService): Finalize =>
    (
      svc as unknown as { finalizeVerdict: Finalize }
    ).finalizeVerdict.bind(svc);

  const base = {
    answer: 'fabricated causal chain',
    citations: [],
    results: [],
  };

  it('supported-but-not-answering declines in lenient verifier abstention', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'supported',
      questionAnswered: false,
      guardrails: 'lenient',
      abstention: 'verifier',
    });
    expect(out.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(out.reason).toBe('low_coverage');
  });

  it('supported + questionAnswered=true passes through', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'supported',
      questionAnswered: true,
      guardrails: 'lenient',
      abstention: 'verifier',
    });
    expect(out.answer).toBe(base.answer);
    expect(out.reason).toBeUndefined();
  });

  it('without verifier abstention the judgment changes nothing', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'supported',
      questionAnswered: false,
      guardrails: 'lenient',
      abstention: 'off',
    });
    expect(out.answer).toBe(base.answer);
  });

  it('strict keeps pre-V10 supported semantics', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'supported',
      questionAnswered: false,
      guardrails: 'strict',
      abstention: 'verifier',
    });
    expect(out.answer).toBe(base.answer);
  });

  it('undefined judgment (topic coverage off) never declines', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'supported',
      guardrails: 'lenient',
      abstention: 'verifier',
    });
    expect(out.answer).toBe(base.answer);
  });

  // V9 §4 core path — the session's one replicated eval win (+17.5pp):
  // in lenient guardrails under 'verifier' abstention, a non-supported
  // verdict IS the coverage signal and returns the explicit decline
  // instead of surfacing the answer with a reason tag.
  it.each(['unsupported', 'partial'] as const)(
    'lenient + verifier abstention declines on a %s verdict',
    (verdict) => {
      const out = finalize(makeService())({
        ...base,
        verdict,
        guardrails: 'lenient',
        abstention: 'verifier',
      });
      expect(out.answer).toBe(NOT_IN_MEMORY_ANSWER);
      expect(out.reason).toBe('low_coverage');
    },
  );

  it('lenient WITHOUT verifier abstention keeps the tagged answer', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'partial',
      guardrails: 'lenient',
      abstention: 'off',
    });
    expect(out.answer).toBe(base.answer);
    expect(out.reason).toBe('verifier_partial');
  });

  it('strict + verifier abstention keeps fail-closed semantics', () => {
    const out = finalize(makeService())({
      ...base,
      verdict: 'unsupported',
      guardrails: 'strict',
      abstention: 'verifier',
    });
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('verifier_failed');
  });
});

describe('coverageAbstention guardrails matrix (V9 §4)', () => {
  function makeService(): SynthesizeService {
    const config = {
      get: (k: string, d?: string) => d,
      getOrThrow: () => 'sk',
    } as unknown as ConfigService;
    const search = {
      search: async () => ({ results: [] }),
    } as unknown as SearchService;
    return new SynthesizeService(search, config);
  }

  type Coverage = (args: {
    profile: Record<string, unknown>;
    guardrails: string;
    results: unknown[];
    explain: boolean;
  }) => { answer: string | null; reason?: string } | null;

  const coverage = (svc: SynthesizeService): Coverage =>
    (
      svc as unknown as { coverageAbstention: Coverage }
    ).coverageAbstention.bind(svc);

  const failingProfile = {
    abstentionCalibration: 'coverage',
    abstentionMinTopScore: 0.5,
    abstentionMinEvidence: 2,
  };
  const thinResults = [
    { facts: [{ factId: 'f1', object: 'x', score: 0.1 }] },
  ];

  it('declines below the floor in strict and lenient', () => {
    for (const guardrails of ['strict', 'lenient']) {
      const out = coverage(makeService())({
        profile: failingProfile,
        guardrails,
        results: thinResults,
        explain: false,
      });
      expect(out?.answer).toBe(NOT_IN_MEMORY_ANSWER);
      expect(out?.reason).toBe('low_coverage');
    }
  });

  it("never fires in 'answer'/'off' guardrails — the never-abstain caller contract", () => {
    for (const guardrails of ['answer', 'off']) {
      expect(
        coverage(makeService())({
          profile: failingProfile,
          guardrails,
          results: thinResults,
          explain: false,
        }),
      ).toBeNull();
    }
  });

  it("never fires when the profile mode is not 'coverage'", () => {
    for (const mode of ['off', 'verifier']) {
      expect(
        coverage(makeService())({
          profile: { ...failingProfile, abstentionCalibration: mode },
          guardrails: 'strict',
          results: thinResults,
          explain: false,
        }),
      ).toBeNull();
    }
  });
});

describe('RETRIEVAL_VERIFIER_TOPIC_COVERAGE profile point', () => {
  it('defaults off; env enables; overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).verifierTopicCoverage,
    ).toBe(false);
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_VERIFIER_TOPIC_COVERAGE: '1',
      } as NodeJS.ProcessEnv).verifierTopicCoverage,
    ).toBe(true);
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { verifierTopicCoverage: true },
      }),
    } as NodeJS.ProcessEnv;
    expect(
      resolveRetrievalProfileFor('beamco', env).verifierTopicCoverage,
    ).toBe(true);
    expect(
      resolveRetrievalProfileFor('other', env).verifierTopicCoverage,
    ).toBe(false);
  });
});

describe('RETRIEVAL_VERIFIER_MODEL profile point (V11 §2 arm a)', () => {
  it("defaults to '' (inherit the synthesis model)", () => {
    expect(resolveRetrievalProfile({} as NodeJS.ProcessEnv).verifierModel).toBe(
      '',
    );
  });

  it('accepts a plain model id and rejects malformed values', () => {
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_VERIFIER_MODEL: 'gpt-5-mini',
      } as NodeJS.ProcessEnv).verifierModel,
    ).toBe('gpt-5-mini');
    // Not a model id → fall back to inherit, never a broken override.
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_VERIFIER_MODEL: 'gpt 5 mini; DROP',
      } as NodeJS.ProcessEnv).verifierModel,
    ).toBe('');
  });

  it('overlays per tenant, empty string restores inherit', () => {
    const env = {
      RETRIEVAL_VERIFIER_MODEL: 'gpt-4o-mini',
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: { verifierModel: 'gpt-5-mini' },
        plainco: { verifierModel: '' },
        badco: { verifierModel: 'nope nope' },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('beamco', env).verifierModel).toBe(
      'gpt-5-mini',
    );
    expect(resolveRetrievalProfileFor('plainco', env).verifierModel).toBe('');
    // Malformed overlay value is ignored — the boot default stands.
    expect(resolveRetrievalProfileFor('badco', env).verifierModel).toBe(
      'gpt-4o-mini',
    );
  });
});
