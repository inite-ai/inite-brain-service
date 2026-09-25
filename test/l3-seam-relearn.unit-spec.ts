import { escalateToL3, UNANSWERED, type L3SeamArgs } from '../src/synthesize/l3-seam';
import type { SynthesizeResult } from '../src/synthesize/synthesize.types';

/**
 * An answer L3 read from raw turns schedules a lesson: those turns are
 * extracted again with the question as focus (relearn-from-raw.service).
 * No flip, no lesson; a flip with no episode citation, no lesson.
 */
describe('the L3 seam schedules relearning from the raw turns it answered from', () => {
  const args = {
    cache: undefined,
    verdict: UNANSWERED,
    companyId: 'co',
    callerScopes: ['brain:read'],
    dto: { query: 'Почему fs выключен?', userId: 'u1' },
    profile: { l3Escalation: true },
    lane: null,
    model: 'm',
    answerLang: null,
    refineAttempted: true,
    results: [],
    factIndex: new Map(),
    promptFactLines: [],
    guardrails: 'strict',
    explain: false,
    decisionCtx: {},
  } as unknown as L3SeamArgs;

  const run = async (l3: unknown) => {
    const scheduled: unknown[] = [];
    const out = await escalateToL3(
      {
        l3: { escalate: async () => l3 } as never,
        logger: { warn: () => undefined } as never,
        openai: {} as never,
        relearn: { schedule: (r) => scheduled.push(r) },
        finalize: async () => ({ answer: 'x', citations: [], results: [] }) as SynthesizeResult,
      },
      args,
    );
    return { out, scheduled };
  };

  it('a flip grounded in raw turns schedules them, with the question and the answer', async () => {
    const { scheduled } = await run({
      verdict: { verdict: 'supported', questionAnswered: true },
      answer: 'На дроплете нет папок для чтения.',
      citations: [],
      evidenceCitations: [{ episodeId: 'episode:a' }, { fragmentId: 'f1' }],
    });
    expect(scheduled).toEqual([
      {
        companyId: 'co',
        userId: 'u1',
        episodeIds: ['episode:a'],
        question: 'Почему fs выключен?',
        answer: 'На дроплете нет папок для чтения.',
      },
    ]);
  });

  it('no flip, or a flip with no raw turn cited, teaches nothing', async () => {
    expect((await run(null)).scheduled).toEqual([]);
    const cited = await run({
      verdict: { verdict: 'supported' },
      answer: 'x',
      citations: [],
      evidenceCitations: [],
    });
    expect(cited.scheduled).toEqual([]);
  });
});
