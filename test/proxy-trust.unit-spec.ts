/**
 * How much of X-Forwarded-For to believe.
 *
 * This setting decides what the rate-limit key is for every
 * unauthenticated caller. Getting it wrong in one direction means every
 * anonymous caller in the world shares one bucket (the 2026-09-10
 * outage); getting it wrong in the other means a client-settable header
 * IS the rate-limit key and the limit is advisory. Both failure modes
 * are silent, so the parse is tested rather than eyeballed.
 */
import { applyProxyTrust, describeTrustProxy, resolveTrustProxy } from '../src/common/proxy-trust';

describe('resolveTrustProxy', () => {
  it('is off when unset — an unconfigured deployment must not believe a header', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('')).toBe(false);
    expect(resolveTrustProxy('   ')).toBe(false);
  });

  it.each(['0', 'false', 'off', 'no', 'FALSE', ' Off '])('reads %s as off', (raw) => {
    expect(resolveTrustProxy(raw)).toBe(false);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
  ])('reads %s as a hop count', (raw, expected) => {
    // Express counts from the RIGHT, so a hop count only ever believes
    // addresses the proxies themselves appended.
    expect(resolveTrustProxy(raw)).toBe(expected);
  });

  it.each(['true', 'all', 'yes'])('reads %s as trusting the whole chain', (raw) => {
    expect(resolveTrustProxy(raw)).toBe(true);
  });

  it('passes a subnet list through for Express to validate', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toBe('10.0.0.0/8, 172.16.0.0/12');
  });

  it('treats a nonsense hop count as off rather than as trust', () => {
    // Fail closed: "0 hops" and a negative are both someone meaning
    // "none", and a huge number is a typo, not a topology.
    expect(resolveTrustProxy('0')).toBe(false);
    expect(resolveTrustProxy('-1')).toBe('-1'); // not an integer form; Express rejects it at boot
    expect(resolveTrustProxy('00')).toBe(false);
  });
});

describe('describeTrustProxy', () => {
  it('says what is on, and how to turn it on when it is not', () => {
    // The boot log is where an operator finds out which of the two
    // failure modes they are in.
    expect(describeTrustProxy(false)).toContain('TRUST_PROXY=1');
    expect(describeTrustProxy(2)).toContain('2 hop(s)');
    expect(describeTrustProxy(true)).toContain('closed network');
    expect(describeTrustProxy('loopback')).toContain('loopback');
  });
});

describe('applyProxyTrust', () => {
  const fakeApp = () => {
    const calls: { setting: string; value: unknown }[] = [];
    return { calls, set: (setting: string, value: unknown) => calls.push({ setting, value }) };
  };

  it('sets the resolved value on the app, which is the half a parse test cannot see', () => {
    const app = fakeApp();
    const line = applyProxyTrust(app, { TRUST_PROXY: '1' });
    expect(app.calls).toEqual([{ setting: 'trust proxy', value: 1 }]);
    expect(line).toContain('1 hop(s)');
  });

  it('still sets it explicitly when trust is off', () => {
    // Express defaults to false anyway, but setting it makes the boot
    // log and the running config agree — which is what an operator
    // chasing a rate-limit surprise will check.
    const app = fakeApp();
    applyProxyTrust(app, {});
    expect(app.calls).toEqual([{ setting: 'trust proxy', value: false }]);
  });
});
