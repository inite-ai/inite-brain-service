/**
 * Unit coverage for the FaithfulnessChecker false-premise (expectRefusal)
 * branch: it must request STRICT guardrails, classify a null answer and
 * the "no grounded evidence" sentinel as refusals (pass), classify a
 * confident answer as a confabulation (fail), and never run the RAGAS
 * faithfulness verifier on a refusal.
 */
import { FaithfulnessChecker } from './eval/runner/faithfulness-checker';
import type { Scenario } from '../src/eval/types';

function fpScenario(): Scenario {
  return {
    id: 'x.false-premise',
    vertical: 'rent' as never,
    description: 'fp',
    setup: [],
    queries: [],
    synthesizeQueries: [
      { query: "What did Anna's brother say?", expectRefusal: true },
    ],
  };
}

function makeChecker(
  synthesize: jest.Mock,
): { checker: FaithfulnessChecker; openai: { chat: { completions: { create: jest.Mock } } } } {
  const brain = { synthesize } as never;
  // The verifier client — asserting it is NEVER called on a refusal.
  const create = jest.fn();
  const openai = { chat: { completions: { create } } };
  return {
    checker: new FaithfulnessChecker(brain, openai as never),
    openai,
  };
}

const emptyRes = (over: Record<string, unknown>) => ({
  answer: null,
  citations: [],
  results: [],
  ...over,
});

describe('FaithfulnessChecker — false-premise branch', () => {
  it('requests STRICT guardrails for expectRefusal queries', async () => {
    const synthesize = jest.fn().mockResolvedValue(emptyRes({ answer: null }));
    const { checker } = makeChecker(synthesize);
    await checker.check(fpScenario());
    expect(synthesize.mock.calls[0][0].synthesisGuardrails).toBe('strict');
  });

  it('a null answer is a refusal → pass, verifier not called', async () => {
    const synthesize = jest
      .fn()
      .mockResolvedValue(emptyRes({ answer: null, reason: 'no_results' }));
    const { checker, openai } = makeChecker(synthesize);
    const out = (await checker.check(fpScenario()))[0]!;
    expect(out.expectedRefusal).toBe(true);
    expect(out.refused).toBe(true);
    expect(out.passed).toBe(true);
    expect(out.faithfulness).toBeNull();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('the "no grounded evidence" sentinel is a refusal → pass', async () => {
    const synthesize = jest.fn().mockResolvedValue(
      emptyRes({ answer: "I don't have grounded evidence for that." }),
    );
    const { checker } = makeChecker(synthesize);
    const out = (await checker.check(fpScenario()))[0]!;
    expect(out.refused).toBe(true);
    expect(out.passed).toBe(true);
  });

  it('a confident answer is a confabulation → fail', async () => {
    const synthesize = jest.fn().mockResolvedValue(
      emptyRes({ answer: 'Her brother said the intercom was fine.', citations: [] }),
    );
    const { checker } = makeChecker(synthesize);
    const out = (await checker.check(fpScenario()))[0]!;
    expect(out.refused).toBe(false);
    expect(out.passed).toBe(false);
    expect(out.expectedRefusal).toBe(true);
  });

  it('an exception fails closed (not a false pass)', async () => {
    const synthesize = jest.fn().mockRejectedValue(new Error('boom'));
    const { checker } = makeChecker(synthesize);
    const out = (await checker.check(fpScenario()))[0]!;
    expect(out.passed).toBe(false);
  });
});
