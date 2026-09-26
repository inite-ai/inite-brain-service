import { triageText, TRIAGE_VERSION } from '../src/documents/triage';
import type { DecisionService } from '../src/ai/decisions/decision.service';
import type { DecisionRequest, DecisionResponse } from '../src/ai/decisions/decision.types';

function plane(answers: DecisionResponse['answers'] | null, enabled = true) {
  const asked: DecisionRequest[] = [];
  const svc = {
    enabled: (lane: string) => enabled && lane === 'triage',
    decide: async (_lane: string, req: DecisionRequest) => {
      asked.push(req);
      return answers ? ({ model: 'jev', answers } as DecisionResponse) : null;
    },
  } as unknown as DecisionService;
  return { svc, asked };
}

describe('triageText (D1, shadow)', () => {
  it('stamps nothing when the lane is off or the plane does not answer', async () => {
    expect(await triageText(plane({}, false).svc, 'text')).toBeNull();
    expect(await triageText(plane(null).svc, 'text')).toBeNull();
    expect(await triageText(undefined, 'text')).toBeNull();
  });

  it('asks the five questions and the salience rubric in ONE request over the text', async () => {
    const { svc, asked } = plane({
      durable: { type: 'noul', noul: 0.92 },
      change: { type: 'noul', noul: 0.81 },
      instruction: { type: 'noul', noul: 0.03 },
      correction: { type: 'noul', noul: 0.4 },
      identity: { type: 'noul', noul: 0.1 },
      salience: {
        type: 'score',
        // The expected value, not a level: the level is the argmax.
        score: 2.1,
        legend: {
          '1': 'routine fact — the neutral default',
          '3': 'notable: decisions, changes, plans, recurring topics',
        },
        probabilities: { '1': 0.3, '3': 0.7 },
        confidence: 0.8,
      },
    });
    const stamp = await triageText(svc, 'Budget moved from 4000 to 2500.');
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.questions).sort()).toEqual(
      ['change', 'correction', 'durable', 'identity', 'instruction', 'salience'].sort(),
    );
    expect(asked[0]!.state).toBe('TEXT:\nBudget moved from 4000 to 2500.');
    expect(stamp).toMatchObject({
      v: TRIAGE_VERSION,
      durable: 0.92,
      change: 0.81,
      instruction: 0.03,
      correction: 0.4,
      identity: 0.1,
      // Found by the level's description, whatever the plane numbers it.
      salience: 2,
    });
  });

  it('an unanswered question reads as maybe, an unreadable salience as routine', async () => {
    const stamp = await triageText(plane({ durable: { type: 'noul', noul: 0.9 } }).svc, 'x');
    expect(stamp).toMatchObject({ durable: 0.9, change: 0.5, instruction: 0.5, salience: 1 });
  });
});
