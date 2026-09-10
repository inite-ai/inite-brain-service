/**
 * Tier multiplier — verified entitlements → throttle-limit multipliers.
 * Pure module; the security property under test is that only the
 * entitlements of a VERIFIED record widen a bucket, and unknown /
 * malformed configuration degrades to the default tier.
 */
import { tierMultiplierFor, tokenTrackerKey } from '../src/auth/tier-multiplier';

describe('tier-multiplier', () => {
  afterEach(() => {
    delete process.env.THROTTLE_TIER_MULTIPLIERS;
  });

  it('tracker key matches the k:<sha256/32> throttler format', () => {
    expect(tokenTrackerKey('some-bearer-token')).toMatch(/^k:[0-9a-f]{32}$/);
  });

  it('picks the largest matching multiplier', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2,"plan:enterprise":5}';
    expect(tierMultiplierFor(['plan:pro', 'plan:enterprise', 'unrelated'])).toBe(5);
  });

  it('defaults to 1 without config, matching entitlements, or a record', () => {
    expect(tierMultiplierFor(undefined)).toBe(1);
    expect(tierMultiplierFor([])).toBe(1);

    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2}';
    expect(tierMultiplierFor(['plan:free'])).toBe(1);
  });

  it('ignores malformed config and out-of-range multipliers', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = 'not-json';
    expect(tierMultiplierFor(['plan:pro'])).toBe(1);

    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":0,"plan:mega":10000}';
    expect(tierMultiplierFor(['plan:pro', 'plan:mega'])).toBe(1);
  });

  it('is stateless: a downgraded plan is at the default tier at once', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2}';
    expect(tierMultiplierFor(['plan:pro'])).toBe(2);
    expect(tierMultiplierFor([])).toBe(1);
  });
});
