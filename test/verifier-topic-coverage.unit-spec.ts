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
        }) => {
          captured.push({
            system: req.messages[0].content,
            schema: req.response_format.json_schema.schema,
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
    expect(captured[0].system).not.toContain('questionAnswered');
    expect(captured[0].schema.properties).not.toHaveProperty('questionAnswered');
    expect(captured[0].schema.required).toEqual(['verdict', 'unsupportedClaims']);
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
    expect(captured[0].system).toContain('Relationship claims');
    expect(captured[0].system).toContain('questionAnswered');
    expect(captured[0].schema.properties).toHaveProperty('questionAnswered');
    expect(captured[0].schema.required).toContain('questionAnswered');
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
