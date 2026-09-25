import { beliefLaneForRequest } from '../src/common/beliefs-flags';

/**
 * A belief is the current state; an asOf question asks about the past.
 * Production answered "which model on 20 September" with today's model
 * from a belief line. The belief lane is not consulted for an asOf read.
 */
describe('the belief lane stays out of an asOf question', () => {
  afterEach(() => {
    delete process.env.BELIEFS_SERVING_LANE;
  });

  it('asOf → no belief lane; no asOf → the lane as configured', () => {
    process.env.BELIEFS_SERVING_LANE = '1';
    expect(beliefLaneForRequest({ asOf: '2026-09-20T12:00:00Z' })).toBe(false);
    expect(beliefLaneForRequest({})).toBe(true);
    process.env.BELIEFS_SERVING_LANE = '0';
    expect(beliefLaneForRequest({})).toBe(false);
  });
});
