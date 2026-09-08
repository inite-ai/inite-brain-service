import type { Surreal } from 'surrealdb';

/**
 * Token-expiry bookkeeping for LONG-LIVED SurrealDB connections.
 *
 * ── The failure this exists to prevent ───────────────────────────────────
 * surrealdb-js 2.0.8 owns session renewal, and it only owns it for sessions
 * it opened itself. `ConnectionController` records `authOverriden = true` the
 * moment `db.signin()` is called from application code (dist/surrealdb.mjs
 * `signin(auth, session, skipOverride = false)`), and its own type
 * declarations say so out loud:
 *
 *   "When this method is called, the `authentication` property passed to
 *    `connect()` will be ignored. You will be responsible for handling
 *    session invalidation by listening to the `auth` event."
 *
 * What "handling" means concretely: on signin the driver schedules a timer at
 * `exp - expiryMargin` (margin defaults to 60s). When it fires,
 * `#applyAuthentication` cannot reuse the near-dead access token, has no
 * refresh token for a system user, and — because `authOverriden` is set —
 * refuses to consult the connect-time auth provider. It falls through to
 * `#abortAuthentication`, which calls `invalidate()`. The socket stays open,
 * `version()` still answers, and every authorization-gated statement from
 * that point on fails with:
 *
 *   "Anonymous access not allowed: Not enough permissions to perform this
 *    action"
 *
 * …for the rest of the process. Nothing expired server-side: `DEFINE USER`
 * defaults to `DURATION FOR TOKEN 1h`, and setting `DURATION FOR SESSION
 * NONE` does NOT help, because the driver reads the JWT `exp` and never asks
 * the server. Verified empirically against surrealdb/surrealdb:v3.2.4 — see
 * test/scoped-session-expiry.e2e-spec.ts.
 *
 * ── The discipline ───────────────────────────────────────────────────────
 * Any connection that outlives its access token must re-`signin()` BEFORE the
 * driver's invalidation timer fires. The root pool already did this the
 * expensive way (unconditionally, on every acquire — see
 * `SurrealService.ensureRootSession`), which is why writes never showed the
 * bug. Doing the same unconditionally on the READ path is not free: a Surreal
 * `signin` runs the server-side password KDF and measures ~16ms against a
 * local v3.2.4, versus ~0.3ms for a `SELECT` — a ~48x tax on every read.
 *
 * So this class tracks the access token's own expiry and re-signs only when
 * the remaining life drops inside a margin. The margin MUST exceed the
 * driver's own `expiryMargin` (60s) or we lose the race with its invalidate
 * timer; 5 minutes leaves a 4-minute buffer on a default 1h token while
 * costing one signin per connection per ~55 minutes.
 */
export const SESSION_REAUTH_MARGIN_MS = 5 * 60_000;

/** The driver's own invalidate-on-expiry lead time (ConnectionController
 *  `#expiryMargin`, seconds). Our margin has to be strictly larger. */
export const DRIVER_EXPIRY_MARGIN_MS = 60_000;

/**
 * Epoch-ms at which a SurrealDB access token expires, or `undefined` when the
 * token is missing or its `exp` claim is unreadable. Callers MUST treat
 * `undefined` as "re-signin now" — guessing an expiry is how you end up
 * anonymous.
 */
export function accessTokenExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    // A non-JWT / malformed token is not an error here — it just means we
    // cannot schedule, so every use re-signs. Correct, merely slower.
    return undefined;
  }
}

/**
 * Remembers, per connection, when the session it holds stops being usable.
 * Keyed weakly so a rebuilt/closed connection is collected with its entry.
 */
export class SurrealSessionKeeper {
  private readonly expiry = new WeakMap<Surreal, number>();

  constructor(private readonly marginMs: number = SESSION_REAUTH_MARGIN_MS) {
    if (marginMs <= DRIVER_EXPIRY_MARGIN_MS) {
      throw new Error(
        `session re-auth margin must exceed the driver's ${DRIVER_EXPIRY_MARGIN_MS}ms ` +
          `invalidate lead time, got ${marginMs}ms`,
      );
    }
  }

  /** True when this connection must be re-signed before it is handed out. */
  needsSignin(conn: Surreal, now: number = Date.now()): boolean {
    const exp = this.expiry.get(conn);
    return exp === undefined || exp - now <= this.marginMs;
  }

  /** Record the token a fresh `signin()` handed back. */
  record(conn: Surreal, accessToken: string | undefined): void {
    const exp = accessTokenExpiryMs(accessToken);
    if (exp === undefined) this.expiry.delete(conn);
    else this.expiry.set(conn, exp);
  }

  /** Drop a connection's record — call when the connection is torn down. */
  forget(conn: Surreal): void {
    this.expiry.delete(conn);
  }
}
