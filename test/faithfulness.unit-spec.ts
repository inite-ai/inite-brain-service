import {
  computeFaithfulness,
  meanFaithfulness,
} from './eval/metrics/faithfulness';
import type {
  FaithfulnessScore,
  OpenAiLike,
} from './eval/metrics/faithfulness';

/**
 * Unit coverage for the faithfulness metric. The OpenAI client is a
 * narrow stub — we just need decomposer + verifier responses in
 * the order the metric calls them.
 */
describe('computeFaithfulness', () => {
  function stubClient(
    responses: Array<{ content: string | null }>,
  ): OpenAiLike {
    let i = 0;
    return {
      chat: {
        completions: {
          create: async () => {
            const r = responses[i] ?? { content: null };
            i++;
            return {
              choices: [{ message: { content: r.content } }],
            };
          },
        },
      },
    };
  }

  it('returns null score on empty answer (nothing to decompose)', async () => {
    const out = await computeFaithfulness(stubClient([]), {
      answer: '',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBeNull();
    expect(out.totalClaims).toBe(0);
    expect(out.claims).toEqual([]);
  });

  it('returns null when decomposer emits zero claims', async () => {
    const out = await computeFaithfulness(
      stubClient([{ content: JSON.stringify({ claims: [] }) }]),
      { answer: 'something', sourceFacts: [] },
    );
    expect(out.faithfulness).toBeNull();
  });

  it('all claims supported → faithfulness=1.0', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          claims: [
            'Alice complained about parking',
            "Alice's complaint was on April 1",
          ],
        }),
      },
      {
        content: JSON.stringify({ verdicts: ['supported', 'supported'] }),
      },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'Alice complained about parking on April 1.',
      sourceFacts: [
        { factId: 'f1', predicate: 'complained_about', object: 'parking' },
      ],
    });
    expect(out.faithfulness).toBe(1.0);
    expect(out.supportedClaims).toBe(2);
    expect(out.partialClaims).toBe(0);
    expect(out.unsupportedClaims).toBe(0);
  });

  it('partial claims weigh 0.5 each (RAGAS convention)', async () => {
    // 4 claims: 2 supported, 1 partial, 1 not_supported.
    // score = (2 + 0.5*1) / 4 = 0.625.
    const client = stubClient([
      {
        content: JSON.stringify({
          claims: ['c1', 'c2', 'c3', 'c4'],
        }),
      },
      {
        content: JSON.stringify({
          verdicts: ['supported', 'supported', 'partial', 'not_supported'],
        }),
      },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'a a a a',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBeCloseTo(0.625, 6);
  });

  it('all unsupported → faithfulness=0', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({ claims: ['c1', 'c2'] }),
      },
      {
        content: JSON.stringify({
          verdicts: ['not_supported', 'not_supported'],
        }),
      },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'a',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBe(0);
  });

  it('decomposer failure → faithfulness=null', async () => {
    const client = stubClient([{ content: null }]);
    const out = await computeFaithfulness(client, {
      answer: 'something',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBeNull();
  });

  it('verifier failure → all verdicts default to not_supported', async () => {
    const client = stubClient([
      { content: JSON.stringify({ claims: ['c1', 'c2'] }) },
      { content: null },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'a',
      sourceFacts: [],
    });
    // Two claims, none verified → faithfulness = 0
    expect(out.faithfulness).toBe(0);
    expect(out.unsupportedClaims).toBe(2);
  });

  it('verifier returns wrong-length array → pad with not_supported', async () => {
    const client = stubClient([
      { content: JSON.stringify({ claims: ['c1', 'c2', 'c3'] }) },
      // Only 2 verdicts for 3 claims; the 3rd should pad to not_supported.
      { content: JSON.stringify({ verdicts: ['supported', 'partial'] }) },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'a',
      sourceFacts: [],
    });
    // Score = (1 + 0.5*1 + 0) / 3 = 0.5
    expect(out.faithfulness).toBeCloseTo(0.5, 6);
    expect(out.claims[2].verdict).toBe('not_supported');
  });

  it('verifier returns invalid enum value → padded to not_supported', async () => {
    const client = stubClient([
      { content: JSON.stringify({ claims: ['c1'] }) },
      { content: JSON.stringify({ verdicts: ['mostly_supported'] }) },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'a',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBe(0);
    expect(out.claims[0].verdict).toBe('not_supported');
  });

  it('claim text round-trips through to the score', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          claims: ['Maya is platinum tier', 'Maya complained'],
        }),
      },
      {
        content: JSON.stringify({
          verdicts: ['supported', 'partial'],
        }),
      },
    ]);
    const out = await computeFaithfulness(client, {
      answer: 'Maya is platinum tier and complained.',
      sourceFacts: [],
    });
    expect(out.claims).toEqual([
      { claim: 'Maya is platinum tier', verdict: 'supported' },
      { claim: 'Maya complained', verdict: 'partial' },
    ]);
  });

  it('decomposer throws → returns null score', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('rate limit');
          },
        },
      },
    } as unknown as OpenAiLike;
    const out = await computeFaithfulness(client, {
      answer: 'a',
      sourceFacts: [],
    });
    expect(out.faithfulness).toBeNull();
  });
});

describe('meanFaithfulness', () => {
  it('returns null on empty input', () => {
    expect(meanFaithfulness([])).toBeNull();
  });

  it('returns null when every input has null faithfulness', () => {
    const empties: FaithfulnessScore[] = [
      {
        faithfulness: null,
        totalClaims: 0,
        supportedClaims: 0,
        partialClaims: 0,
        unsupportedClaims: 0,
        claims: [],
      },
      {
        faithfulness: null,
        totalClaims: 0,
        supportedClaims: 0,
        partialClaims: 0,
        unsupportedClaims: 0,
        claims: [],
      },
    ];
    expect(meanFaithfulness(empties)).toBeNull();
  });

  it('skips null inputs and averages the rest', () => {
    const inputs: FaithfulnessScore[] = [
      {
        faithfulness: 1.0,
        totalClaims: 2,
        supportedClaims: 2,
        partialClaims: 0,
        unsupportedClaims: 0,
        claims: [],
      },
      {
        faithfulness: 0.0,
        totalClaims: 2,
        supportedClaims: 0,
        partialClaims: 0,
        unsupportedClaims: 2,
        claims: [],
      },
      {
        faithfulness: null,
        totalClaims: 0,
        supportedClaims: 0,
        partialClaims: 0,
        unsupportedClaims: 0,
        claims: [],
      },
    ];
    expect(meanFaithfulness(inputs)).toBe(0.5);
  });
});
