import { runLocomo, type QaAgent } from './eval/locomo/runner';
import type { LlmJudge } from './eval/locomo/judge';
import type { NormalizedConversation } from './eval/locomo/types';

/**
 * runLocomo qaConcurrency — questions run through a bounded pool, but the
 * report MUST stay in load order (results written back by index), and a
 * judge must still grade each. Guards the serial→concurrent refactor.
 */
function conv(id: string, questions: string[]): NormalizedConversation {
  return {
    sampleId: id,
    speakerA: 'A',
    speakerB: 'B',
    sessions: [{ index: 1, dateTime: '2023-01-01T00:00:00.000Z', turns: [] }],
    qa: questions.map((q, i) => ({
      question: q,
      // gold == prediction so the token metrics are trivially satisfiable;
      // this test is about ORDER + wiring, not scoring quality.
      answer: `ans:${q}`,
      category: ((i % 4) + 1) as 1 | 2 | 3 | 4,
      evidence: [],
    })),
  };
}

/**
 * Agent that echoes the question but finishes in REVERSE arrival order
 * (earlier questions sleep longer), so a naive push-on-complete loop would
 * scramble the report. Order preservation must come from index write-back.
 */
function reversingAgent(total: number): QaAgent {
  let seen = 0;
  return {
    async answer({ question }) {
      const n = seen++;
      const delay = (total - n) * 3; // first-arriving waits longest
      await new Promise((r) => setTimeout(r, delay));
      return `ans:${question}`;
    },
  };
}

const passthroughJudge: LlmJudge = {
  async grade({ gold, prediction }) {
    return { correct: gold === prediction };
  },
};

describe('runLocomo qaConcurrency', () => {
  it('preserves LOAD order in the report despite out-of-order completion', async () => {
    const convs = [
      conv('c1', ['q0', 'q1', 'q2', 'q3']),
      conv('c2', ['q4', 'q5', 'q6']),
    ];
    const total = 7;
    const report = await runLocomo(convs, reversingAgent(total), {
      qaConcurrency: 4,
      companyIdFor: (c) => `co_${c.sampleId}`,
    });
    expect(report.scores).toHaveLength(total);
    // Report order == load order (c1's 4 then c2's 3), each matched to its Q.
    expect(report.scores.map((s) => s.question)).toEqual([
      'q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6',
    ]);
    expect(report.scores.map((s) => s.prediction)).toEqual([
      'ans:q0', 'ans:q1', 'ans:q2', 'ans:q3', 'ans:q4', 'ans:q5', 'ans:q6',
    ]);
    // Sample attribution stays correct after the flatten/pool.
    expect(report.scores.slice(0, 4).every((s) => s.sampleId === 'c1')).toBe(true);
    expect(report.scores.slice(4).every((s) => s.sampleId === 'c2')).toBe(true);
  });

  it('applies the judge to every question under concurrency', async () => {
    const convs = [conv('c1', ['q0', 'q1', 'q2', 'q3', 'q4'])];
    const report = await runLocomo(convs, reversingAgent(5), {
      qaConcurrency: 3,
      judge: passthroughJudge,
    });
    expect(report.scores.every((s) => s.judgeCorrect === true)).toBe(true);
    expect(report.overall.judgeAccuracy).toBe(1);
    expect(report.overall.judgedN).toBe(5);
  });

  it('caps at maxQuestions in load order under concurrency', async () => {
    const convs = [conv('c1', ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'])];
    const report = await runLocomo(convs, reversingAgent(6), {
      qaConcurrency: 4,
      maxQuestions: 3,
    });
    expect(report.scores).toHaveLength(3);
    expect(report.scores.map((s) => s.question)).toEqual(['q0', 'q1', 'q2']);
  });

  it('concurrency 1 (default) stays serial and correct', async () => {
    const convs = [conv('c1', ['q0', 'q1', 'q2'])];
    const report = await runLocomo(convs, reversingAgent(3), {});
    expect(report.scores.map((s) => s.question)).toEqual(['q0', 'q1', 'q2']);
  });
});
