import { ConfigService } from '@nestjs/config';
import { DecisionService } from '../src/ai/decisions/decision.service';
import { JevClient } from '../src/ai/decisions/jev.client';
import { certaintyOf } from '../src/ai/decisions/decision.types';
import type { DecisionResponse } from '../src/ai/decisions/decision.types';
import type { MetricsService } from '../src/metrics/metrics.service';

/**
 * The decision plane's two contracts, which every lane depends on:
 *
 *   * a lane is OFF unless it is named AND the plane has a key — an
 *     unconfigured plane must never swallow a judgement;
 *   * a decision below the lane's confidence floor is not a verdict. The
 *     caller escalates, which is the only reason answering the easy cases on
 *     a cheap model is safe.
 */
const cfg = (values: Record<string, string>): ConfigService =>
  ({
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  }) as unknown as ConfigService;

const jevStub = (available: boolean, res: DecisionResponse | null = null): JevClient =>
  ({
    available: () => available,
    modelId: () => 'jev-latest',
    decide: async () => res,
  }) as unknown as JevClient;

describe('decision plane — lane gating', () => {
  it('a lane is off when it is not named', () => {
    const s = new DecisionService(cfg({ DECISIONS_LANES: 'verifier' }), jevStub(true));
    expect(s.enabled('verifier')).toBe(true);
    expect(s.enabled('entity_judge')).toBe(false);
  });

  it('every lane is off without a key, however it is configured', () => {
    const s = new DecisionService(cfg({ DECISIONS_LANES: 'all' }), jevStub(false));
    expect(s.enabled('verifier')).toBe(false);
    expect(s.enabled('entity_judge')).toBe(false);
  });

  it('is off entirely when the client is not wired in', () => {
    const s = new DecisionService(cfg({ DECISIONS_LANES: 'all' }));
    expect(s.enabled('verifier')).toBe(false);
  });

  it('`all` opts every lane in', () => {
    const s = new DecisionService(cfg({ DECISIONS_LANES: 'all' }), jevStub(true));
    expect(s.enabled('reranker')).toBe(true);
  });

  it('decide() answers null for a lane that is off — never a default verdict', async () => {
    const s = new DecisionService(cfg({}), jevStub(true));
    await expect(s.decide('verifier', { state: 'x', questions: {} })).resolves.toBeNull();
  });
});

describe('decision plane — the confidence floor', () => {
  it('a noul is certain by its distance from the coin flip', () => {
    expect(certaintyOf({ type: 'noul', noul: 0.5 })).toBeCloseTo(0);
    expect(certaintyOf({ type: 'noul', noul: 0.95 })).toBeCloseTo(0.9);
    expect(certaintyOf({ type: 'noul', noul: 0.02 })).toBeCloseTo(0.96);
  });

  it('a choice reports its own concentration', () => {
    expect(
      certaintyOf({
        type: 'choice',
        choice: 'a',
        probabilities: { a: 0.9, b: 0.1 },
        confidence: 0.81,
      }),
    ).toBeCloseTo(0.81);
  });

  it('the floor is per lane, falling back to the global one', () => {
    const s = new DecisionService(
      cfg({
        DECISIONS_LANES: 'all',
        DECISIONS_CONFIDENCE_FLOOR: '0.6',
        DECISIONS_CONFIDENCE_FLOOR_VERIFIER: '0.9',
      }),
      jevStub(true),
    );
    expect(s.floorFor('verifier')).toBeCloseTo(0.9);
    expect(s.floorFor('entity_judge')).toBeCloseTo(0.6);
    expect(s.confident('entity_judge', { type: 'noul', noul: 0.85 })).toBe(true); // .7 ≥ .6
    expect(s.confident('verifier', { type: 'noul', noul: 0.85 })).toBe(false); // .7 < .9
  });

  it('every decision is counted as acted, escalated or unanswered', async () => {
    // Without this split the plane is invisible on prod: a cheap decision and
    // the expensive fallback it triggered land in the same token counter.
    const counted: Array<[string, string]> = [];
    const metrics = {
      countDecision: (lane: string, outcome: string) => counted.push([lane, outcome]),
    } as unknown as MetricsService;

    const s = new DecisionService(
      cfg({ DECISIONS_LANES: 'all', DECISIONS_CONFIDENCE_FLOOR: '0.8' }),
      jevStub(true, null),
      metrics,
    );
    s.confident('entity_judge', { type: 'noul', noul: 0.99 });
    s.confident('entity_judge', { type: 'noul', noul: 0.55 });
    await s.decide('verifier', {
      state: 'x',
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    expect(counted).toEqual([
      ['entity_judge', 'acted'],
      ['entity_judge', 'escalated'],
      ['verifier', 'unanswered'],
    ]);
  });

  it('a malformed floor falls back instead of disabling the gate', () => {
    const s = new DecisionService(
      cfg({ DECISIONS_LANES: 'all', DECISIONS_CONFIDENCE_FLOOR_RERANKER: 'yes please' }),
      jevStub(true),
    );
    expect(s.floorFor('reranker')).toBeCloseTo(0.7);
  });
});
