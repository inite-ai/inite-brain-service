/**
 * A contested value's learned likelihood (#847) as the focus view shows
 * it: beside the `[competing]` mark, never in place of the rival.
 */
import { likelihood } from '../src/mcp/compact-read';

describe('likelihood label', () => {
  it('says likely or unlikely with the posterior, and nothing when nothing was learned', () => {
    expect(likelihood({ truth: { posterior: 0.824 } })).toBe(', likely 0.82');
    expect(likelihood({ truth: { posterior: 0.18 } })).toBe(', unlikely 0.18');
    expect(likelihood({})).toBe('');
  });
});
