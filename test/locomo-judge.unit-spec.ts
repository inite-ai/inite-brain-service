/**
 * Coverage for the LoCoMo LLM-as-judge (--judge) and its runner
 * integration. Stubbed OpenAiLike — no network. Pins: prompt/schema
 * shape, correct/wrong mapping, empty-prediction short-circuit,
 * abstention handling, malformed-response containment (judgeErrored,
 * run continues), and the judgeAccuracy aggregation (judged-only, absent
 * when the judge is off).
 */
import {
  createOpenAiJudge,
  LOCOMO_JUDGE_SYSTEM,
} from '../test/eval/locomo/judge';
import { runLocomo, rejudgeScores } from '../test/eval/locomo/runner';
import type { QuestionScore } from '../test/eval/locomo/runner';
import type { NormalizedConversation } from '../test/eval/locomo/types';
import type { OpenAiLike } from '../test/eval/metrics/faithfulness';

function stubOpenAi(replies: boolean[]): {
  client: OpenAiLike;
  create: jest.Mock;
} {
  let i = 0;
  const create = jest.fn(async () => ({
    choices: [
      { message: { content: JSON.stringify({ correct: replies[i++] }) } },
    ],
  }));
  return { client: { chat: { completions: { create } } }, create };
}

describe('createOpenAiJudge', () => {
  it('maps a CORRECT verdict and sends the fixed prompt + strict schema', async () => {
    const { client, create } = stubOpenAi([true]);
    const judge = createOpenAiJudge(client, 'gpt-4.1-mini');
    const out = await judge.grade({
      question: 'Where does Ada live?',
      gold: 'Berlin',
      prediction: 'She lives in Berlin.',
      category: 1,
    });
    expect(out.correct).toBe(true);
    const arg = create.mock.calls[0][0] as any;
    expect(arg.messages[0].content).toBe(LOCOMO_JUDGE_SYSTEM);
    expect(arg.temperature).toBe(0);
    expect(arg.response_format.json_schema.strict).toBe(true);
    expect(arg.response_format.json_schema.schema.required).toEqual(['correct']);
  });

  it('short-circuits an empty prediction to WRONG without an API call', async () => {
    const { client, create } = stubOpenAi([]);
    const judge = createOpenAiJudge(client, 'm');
    const out = await judge.grade({
      question: 'q',
      gold: 'Berlin',
      prediction: '   ',
      category: 1,
    });
    expect(out.correct).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('still calls the judge on an empty prediction when the gold is abstention', async () => {
    const { client, create } = stubOpenAi([true]);
    const judge = createOpenAiJudge(client, 'm');
    const out = await judge.grade({
      question: 'q',
      gold: 'No information available.',
      prediction: '',
      category: 5,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.correct).toBe(true);
  });

  it('throws on a malformed judge response', async () => {
    const create = jest.fn(async () => ({
      choices: [{ message: { content: '{"correct":"yes"}' } }],
    }));
    const judge = createOpenAiJudge(
      { chat: { completions: { create } } },
      'm',
    );
    await expect(
      judge.grade({ question: 'q', gold: 'g', prediction: 'p', category: 1 }),
    ).rejects.toThrow(/malformed/);
  });
});

function convWith(qa: NormalizedConversation['qa']): NormalizedConversation {
  return {
    sampleId: 's1',
    sessions: [],
    qa,
    speakerA: 'A',
    speakerB: 'B',
  } as NormalizedConversation;
}

describe('runLocomo — judge integration', () => {
  const agent = { answer: async () => 'the predicted answer' };
  const qa = [
    { question: 'q1', answer: 'a1', category: 1 },
    { question: 'q2', answer: 'a2', category: 1 },
  ] as NormalizedConversation['qa'];

  it('no judge → report carries no judge fields (back-compat)', async () => {
    const report = await runLocomo([convWith(qa)], agent);
    expect(report.overall.judgeAccuracy).toBeUndefined();
    expect(report.perCategory[0].judgeAccuracy).toBeUndefined();
    expect(report.scores.every((s) => s.judgeCorrect === undefined)).toBe(true);
  });

  it('judge on → judgeAccuracy over judged questions', async () => {
    const { client } = stubOpenAi([true, false]);
    const judge = createOpenAiJudge(client, 'm');
    const report = await runLocomo([convWith(qa)], agent, { judge });
    expect(report.overall.judgeAccuracy).toBe(0.5);
    expect(report.overall.judgedN).toBe(2);
  });

  it('a judge error is recorded and does not fail the run or the mean', async () => {
    // First grade throws, second succeeds → judgedN=1, accuracy=1.
    let i = 0;
    const create = jest.fn(async () => {
      if (i++ === 0) throw new Error('judge 500');
      return { choices: [{ message: { content: '{"correct":true}' } }] };
    });
    const judge = createOpenAiJudge(
      { chat: { completions: { create } } },
      'm',
    );
    const report = await runLocomo([convWith(qa)], agent, { judge });
    expect(report.totalQuestions).toBe(2);
    expect(report.overall.judgedN).toBe(1);
    expect(report.overall.judgeAccuracy).toBe(1);
    expect(report.scores.some((s) => s.judgeErrored)).toBe(true);
  });

  it('rejudgeScores re-grades an existing score set offline', async () => {
    const scores: QuestionScore[] = [
      {
        sampleId: 's',
        category: 1,
        question: 'q',
        gold: 'g',
        prediction: 'p',
        f1: 0.5,
        rougeL: 0.5,
        bleu1: 0.5,
        exactMatch: 0,
        adversarial: 0,
        judgeErrored: 'stale error',
      },
    ];
    const { client } = stubOpenAi([true]);
    const report = await rejudgeScores(scores, createOpenAiJudge(client, 'm'));
    expect(report.overall.judgeAccuracy).toBe(1);
    expect(report.scores[0].judgeCorrect).toBe(true);
    expect(report.scores[0].judgeErrored).toBeUndefined();
  });
});
