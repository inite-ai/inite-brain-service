import type { Surreal } from 'surrealdb';

/**
 * Token-expiry bookkeeping for LONG-LIVED SurrealDB connections.
 *
 * Contract: surrealdb-js (2.0.8) renews only sessions it opened itself. A
 * session established by `db.signin()` from application code is INVALIDATED
 * by the driver at `exp − 60s` — client-side, from the JWT `exp`, regardless
 * of any server `DURATION FOR SESSION` — after which the socket stays open,
 * `version()` still answers, and every authorization-gated statement fails
 * with "Anonymous access not allowed". So every connection that outlives its
 * token must re-`signin()` before that timer fires. This class records each
 * connection's token expiry and answers whether it must be re-signed now:
 * inside the margin, or never seen, or holding an unreadable token — never
 * "assume valid". The margin must exceed the driver's 60s lead time; 5 min
 * costs one signin (≈16 ms, the server-side KDF) per connection per ~55 min
 * on a default 1h token.
 *
 * Owners: SurrealService (both pools), LiveSubscriptionManager, the backfill
 * script. Proof against a real server: test/scoped-session-expiry.e2e-spec.ts.
 * Incident: docs/audits/runtime-auth-embedding-2026-09-08.md.
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
