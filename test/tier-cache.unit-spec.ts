/**
 * Tier cache — verified entitlements → throttle-limit multipliers.
 * Pure module; the security property under test is that only
 * post-verification recordTier() calls widen a bucket, and unknown /
 * malformed configuration degrades to the default tier.
 */
import { recordTier, tierMultiplier, tokenTrackerKey } from '../src/auth/tier-cache';

describe('tier-cache', () => {
  const key = tokenTrackerKey('some-bearer-token');

  afterEach(() => {
    delete process.env.THROTTLE_TIER_MULTIPLIERS;
    recordTier(key, []); // clears the entry
  });

  it('tracker key matches the k:<sha256/32> throttler format', () => {
    expect(key).toMatch(/^k:[0-9a-f]{32}$/);
  });

  it('records the largest matching multiplier', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2,"plan:enterprise":5}';
    recordTier(key, ['plan:pro', 'plan:enterprise', 'unrelated']);
    expect(tierMultiplier(key)).toBe(5);
  });

  it('defaults to 1 without config, matching entitlements, or a record', () => {
    expect(tierMultiplier('k:unknown')).toBe(1);

    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2}';
    recordTier(key, ['plan:free']);
    expect(tierMultiplier(key)).toBe(1);
  });

  it('ignores malformed config and out-of-range multipliers', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = 'not-json';
    recordTier(key, ['plan:pro']);
    expect(tierMultiplier(key)).toBe(1);

    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":0,"plan:mega":10000}';
    recordTier(key, ['plan:pro', 'plan:mega']);
    expect(tierMultiplier(key)).toBe(1);
  });

  it('re-recording without entitlements clears the tier (plan downgrade)', () => {
    process.env.THROTTLE_TIER_MULTIPLIERS = '{"plan:pro":2}';
    recordTier(key, ['plan:pro']);
    expect(tierMultiplier(key)).toBe(2);
    recordTier(key, []);
    expect(tierMultiplier(key)).toBe(1);
  });
});
