/**
 * Pack version ordering — the semver compare that drives the registry's
 * latest-non-yanked resolution.
 */
import { compareSemver, pickLatestVersion } from '../src/ai/domain-packs';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1); // numeric, not lexical
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('pickLatestVersion', () => {
  it('returns the highest semver', () => {
    expect(pickLatestVersion(['0.1.0', '1.0.0', '0.9.9'])).toBe('1.0.0');
    expect(pickLatestVersion(['1.2.0', '1.10.0', '1.9.0'])).toBe('1.10.0');
  });
  it('returns null for an empty list', () => {
    expect(pickLatestVersion([])).toBeNull();
  });
  it('handles a single version', () => {
    expect(pickLatestVersion(['3.1.4'])).toBe('3.1.4');
  });
});
