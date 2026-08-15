/**
 * BEAM official nugget judge (--nugget-judge): pins the pure scoring
 * core (Kendall tau-b with ties, the official tie-rank convention,
 * P/R/F1 over canonicalised lists), the newline-split convention, the
 * partial-credit aggregation (the reference implementation's int()
 * truncation bug must NOT be reproduced), and the <question>
 * substitution (the reference implementation never substitutes it).
 * Stubbed OpenAiLike — no network.
 */
import {
  createNuggetJudge,
  kendallTauB,
  orderingScoreFromCanon,
  splitOrderingResponse,
  BEAM_NUGGET_JUDGE_PROMPT,
} from '../test/eval/beam/nugget-judge';
import type { OpenAiLike } from '../test/eval/metrics/faithfulness';

function stubOpenAi(replies: string[]): {
  client: OpenAiLike;
  create: jest.Mock;
} {
  let i = 0;
  const create = jest.fn(async () => ({
    choices: [{ message: { content: replies[i++] } }],
  }));
  return { client: { chat: { completions: { create } } }, create };
}

describe('kendallTauB', () => {
  it('perfect agreement → 1, perfect reversal → -1', () => {
    expect(kendallTauB([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(kendallTauB([1, 2, 3], [3, 2, 1])).toBe(-1);
  });
  it('all-tied vectors → null (scipy nan)', () => {
    expect(kendallTauB([1, 1, 1], [2, 2, 2])).toBeNull();
  });
  it('handles ties like variant=b', () => {
    // x: 1,2,3,4; y: 1,1,2,3 — one tied pair in y
    // pairs: (1,2):dx≠0,dy=0 → tieY; 5 concordant
    // tau_b = 5 / sqrt(6*5) ≈ 0.9129
    expect(kendallTauB([1, 2, 3, 4], [1, 1, 2, 3])!).toBeCloseTo(
      5 / Math.sqrt(30),
      10,
    );
  });
});

describe('orderingScoreFromCanon', () => {
  it('identical lists → tauNorm 1, f1 1', () => {
    const r = orderingScoreFromCanon(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(r.tauNorm).toBe(1);
    expect(r.f1).toBe(1);
    expect(r.finalScore).toBe(1);
  });
  it('reversed order → tauNorm 0, f1 stays 1', () => {
    const r = orderingScoreFromCanon(['a', 'b', 'c'], ['c', 'b', 'a']);
    expect(r.tauNorm).toBe(0);
    expect(r.f1).toBe(1);
  });
  it('unmatched items share the tie rank (official convention)', () => {
    // system has 'a' plus a stray 'x'; union = [a,b,x], tie_rank = 4
    // ref ranks: a=1,b=2,x=4 ; sys ranks: a=1,b=4,x=2
    const r = orderingScoreFromCanon(['a', 'b'], ['a', 'x']);
    expect(r.precision).toBe(0.5);
    expect(r.recall).toBe(0.5);
    expect(r.f1).toBe(0.5);
    // tau_b over ([1,2,4],[1,4,2]) = (2-1)/3 = 1/3 → norm = 2/3
    expect(r.tauNorm).toBeCloseTo(2 / 3, 10);
    expect(r.finalScore).toBeCloseTo(1 / 3, 10);
  });
  it('empty system list → zeros, no NaN', () => {
    const r = orderingScoreFromCanon(['a', 'b'], []);
    expect(r.f1).toBe(0);
    expect(r.tauNorm).toBe(0);
    expect(Number.isNaN(r.finalScore)).toBe(false);
  });
});

describe('splitOrderingResponse', () => {
  it('splits on newlines, trims, drops blanks', () => {
    expect(splitOrderingResponse('1. Core\n\n  2. Errors  \n')).toEqual([
      '1. Core',
      '2. Errors',
    ]);
  });
});

describe('createNuggetJudge.scoreQuestion', () => {
  it('averages float scores — 0.5 partial credit SURVIVES (no int())', async () => {
    const { client } = stubOpenAi([
      '{"score": 1.0, "reason": "full"}',
      '{"score": 0.5, "reason": "partial"}',
    ]);
    const judge = createNuggetJudge(client, 'gpt-4.1-mini');
    const out = await judge.scoreQuestion({
      question: 'How many weeks?',
      rubric: ['states 8 weeks', 'states the date range'],
      prediction: '8 weeks, from January till March',
    });
    expect(out.itemScores).toEqual([1, 0.5]);
    expect(out.nuggetScore).toBe(0.75);
  });

  it('substitutes <question> and <rubric_item> into the official prompt', async () => {
    const { client, create } = stubOpenAi(['{"score": 0.0, "reason": "no"}']);
    const judge = createNuggetJudge(client, 'gpt-4.1-mini');
    await judge.scoreQuestion({
      question: 'What is the deadline?',
      rubric: ['states March 15'],
      prediction: 'No idea.',
    });
    const prompt = (create.mock.calls[0][0] as any).messages[0]
      .content as string;
    expect(prompt).toContain('What is the deadline?');
    expect(prompt).toContain('states March 15');
    expect(prompt).not.toContain('<question>');
    expect(prompt).not.toContain('<rubric_item>');
    expect(BEAM_NUGGET_JUDGE_PROMPT).toContain('<question>');
  });

  it('accepts ```json fenced output; rejects off-scale scores', async () => {
    const { client } = stubOpenAi([
      '```json\n{"score": 0.5, "reason": "ok"}\n```',
      '{"score": 0.7, "reason": "invalid"}',
    ]);
    const judge = createNuggetJudge(client, 'gpt-4.1-mini');
    const ok = await judge.scoreQuestion({
      question: 'q',
      rubric: ['r'],
      prediction: 'p',
    });
    expect(ok.nuggetScore).toBe(0.5);
    await expect(
      judge.scoreQuestion({ question: 'q', rubric: ['r'], prediction: 'p' }),
    ).rejects.toThrow(/invalid score/);
  });
});

describe('createNuggetJudge.orderingScore', () => {
  it('greedy-aligns via YES/NO equivalence, then scores tau over ranks', async () => {
    // system: "1. Errors" ≡ ref "Transaction error handling" (YES on
    // 2nd ref item after NO on 1st), "2. Core" ≡ ref "Core
    // functionality" (YES on 1st unclaimed).
    const { client, create } = stubOpenAi(['NO', 'YES', 'YES']);
    const judge = createNuggetJudge(client, 'gpt-4.1-mini');
    const r = await judge.orderingScore({
      rubric: ['Core functionality', 'Transaction error handling'],
      prediction: '1. Errors\n2. Core',
    });
    // both matched (f1=1) but order reversed → tauNorm 0
    expect(r.f1).toBe(1);
    expect(r.tauNorm).toBe(0);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
