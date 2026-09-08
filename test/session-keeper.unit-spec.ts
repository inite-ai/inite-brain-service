/**
 * SurrealSessionKeeper — the freshness arithmetic that keeps long-lived
 * SurrealDB connections out of the driver's invalidate-on-expiry path.
 *
 * The behavioural proof (a real connection actually going anonymous, and the
 * pool surviving it) lives in test/scoped-session-expiry.e2e-spec.ts; this
 * pins the decision rule itself, including the two ways it must fail safe.
 */
import type { Surreal } from 'surrealdb';
import {
  DRIVER_EXPIRY_MARGIN_MS,
  SESSION_REAUTH_MARGIN_MS,
  SurrealSessionKeeper,
  accessTokenExpiryMs,
} from '../src/db/session-keeper';

/** A syntactically real JWT with the given `exp` (seconds). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS512', typ: 'JWT' })}.${b64(claims)}.c2ln`;
}

/** The keeper only ever uses connections as WeakMap keys. */
const conn = () => ({}) as unknown as Surreal;

describe('accessTokenExpiryMs', () => {
  it('reads the exp claim as epoch-ms', () => {
    expect(accessTokenExpiryMs(jwt({ exp: 1788883374 }))).toBe(1788883374000);
  });

  it('returns undefined for anything it cannot read', () => {
    expect(accessTokenExpiryMs(undefined)).toBeUndefined();
    expect(accessTokenExpiryMs('')).toBeUndefined();
    expect(accessTokenExpiryMs('not-a-jwt')).toBeUndefined();
    expect(accessTokenExpiryMs('a.b.c')).toBeUndefined();
    // A token with no exp claim (SurrealDB bearer keys) must not be
    // mistaken for one that never expires.
    expect(accessTokenExpiryMs(jwt({ ID: 'brain_caller' }))).toBeUndefined();
    expect(accessTokenExpiryMs(jwt({ exp: 'soon' }))).toBeUndefined();
  });
});

describe('SurrealSessionKeeper', () => {
  const NOW = 1_800_000_000_000;
  const tokenExpiringIn = (ms: number) => jwt({ exp: Math.floor((NOW + ms) / 1000) });

  it('refuses a margin the driver would beat it to', () => {
    // surrealdb-js invalidates at exp-60s. A margin at or below that loses
    // the race, which is the whole failure this class exists to prevent.
    expect(() => new SurrealSessionKeeper(DRIVER_EXPIRY_MARGIN_MS)).toThrow(/must exceed/);
    expect(() => new SurrealSessionKeeper(30_000)).toThrow(/must exceed/);
    expect(() => new SurrealSessionKeeper(DRIVER_EXPIRY_MARGIN_MS + 1)).not.toThrow();
  });

  it('demands a signin for a connection it has never seen', () => {
    expect(new SurrealSessionKeeper().needsSignin(conn(), NOW)).toBe(true);
  });

  it('holds off while the token has more life than the margin', () => {
    const keeper = new SurrealSessionKeeper();
    const c = conn();
    keeper.record(c, tokenExpiringIn(3_600_000)); // a default 1h token
    expect(keeper.needsSignin(c, NOW)).toBe(false);
    // …and keeps holding off right up to the margin.
    expect(keeper.needsSignin(c, NOW + 3_600_000 - SESSION_REAUTH_MARGIN_MS - 1000)).toBe(false);
  });

  it('demands a signin once the token enters the margin — before the driver acts', () => {
    const keeper = new SurrealSessionKeeper();
    const c = conn();
    keeper.record(c, tokenExpiringIn(3_600_000));
    const atMargin = NOW + 3_600_000 - SESSION_REAUTH_MARGIN_MS;
    expect(keeper.needsSignin(c, atMargin)).toBe(true);
    // The driver would not have invalidated yet at that point: our margin
    // has to leave real headroom over its 60s lead time.
    expect(SESSION_REAUTH_MARGIN_MS).toBeGreaterThan(DRIVER_EXPIRY_MARGIN_MS);
  });

  it('demands a signin for an already-lapsed token', () => {
    const keeper = new SurrealSessionKeeper();
    const c = conn();
    keeper.record(c, tokenExpiringIn(-1));
    expect(keeper.needsSignin(c, NOW)).toBe(true);
  });

  it('fails safe when the token is unreadable — re-signs every time', () => {
    const keeper = new SurrealSessionKeeper();
    const c = conn();
    keeper.record(c, tokenExpiringIn(3_600_000));
    expect(keeper.needsSignin(c, NOW)).toBe(false);
    // A driver/server that stops handing back a parseable JWT must degrade
    // to "sign in on every use", never to "assume it is still valid".
    keeper.record(c, 'opaque-token');
    expect(keeper.needsSignin(c, NOW)).toBe(true);
  });

  it('forgets a torn-down connection', () => {
    const keeper = new SurrealSessionKeeper();
    const c = conn();
    keeper.record(c, tokenExpiringIn(3_600_000));
    keeper.forget(c);
    expect(keeper.needsSignin(c, NOW)).toBe(true);
  });

  it('tracks connections independently', () => {
    const keeper = new SurrealSessionKeeper();
    const fresh = conn();
    const stale = conn();
    keeper.record(fresh, tokenExpiringIn(3_600_000));
    keeper.record(stale, tokenExpiringIn(10_000));
    expect(keeper.needsSignin(fresh, NOW)).toBe(false);
    expect(keeper.needsSignin(stale, NOW)).toBe(true);
  });
});
