/**
 * How much of `X-Forwarded-For` to believe.
 *
 * Every rate limit brain applies to an unauthenticated caller is keyed
 * on the client IP, and behind Traefik every request arrives from the
 * proxy's address. Without proxy trust, every anonymous caller in the
 * world shares one bucket — which is not a theoretical concern here: it
 * is the mechanism behind the 2026-09-10 outage, where the health probe
 * and the internet were counted together until the edge pulled the only
 * replica out of rotation.
 *
 * Trust is OFF by default and stays off, because turning it on wrongly
 * is worse than leaving it off: a header a client can set becomes the
 * rate-limit key, and the limit becomes advisory. It has to be an
 * explicit statement of how many proxies actually sit in front of this
 * deployment.
 *
 * `TRUST_PROXY` takes exactly what Express's `trust proxy` setting
 * takes, and this module's only job is deciding which form was meant:
 *
 *   unset | 0 | false | off   → false. No trust. The default.
 *   1 | 2 | …                 → that many hops from the right-hand end
 *                               of X-Forwarded-For. One Traefik in front
 *                               of the app is `1`.
 *   true | all                → trust the whole chain. Only ever correct
 *                               on a closed network; the leftmost entry
 *                               is client-controlled.
 *   loopback | 10.0.0.0/8 | … → a named range or comma-separated list of
 *                               addresses/CIDRs to believe.
 */

export type TrustProxySetting = boolean | number | string;

const OFF = new Set(['', '0', 'false', 'off', 'no']);
const ALL = new Set(['true', 'all', 'yes']);

export function resolveTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (OFF.has(value)) return false;
  if (ALL.has(value)) return true;
  // A bare integer is a hop count. Express reads the Nth address from
  // the RIGHT, so only addresses the proxies themselves appended are
  // ever believed — this is the form almost every deployment wants.
  if (/^\d+$/.test(value)) {
    const hops = Number.parseInt(value, 10);
    return Number.isSafeInteger(hops) && hops > 0 ? hops : false;
  }
  // Anything else is handed through as a subnet / named-range list.
  // Express validates it and throws at boot on a malformed entry, which
  // is the right moment to find out.
  return raw ?? false;
}

/** One line for the boot log, so the setting is visible in production. */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) {
    return 'trust proxy: off — anonymous rate limits key on the socket address (set TRUST_PROXY=1 behind a reverse proxy)';
  }
  if (setting === true) {
    return 'trust proxy: ALL hops — the client-supplied end of X-Forwarded-For is believed; correct only on a closed network';
  }
  if (typeof setting === 'number') {
    return `trust proxy: ${setting} hop(s) from the right of X-Forwarded-For`;
  }
  return `trust proxy: ${setting}`;
}

/** Minimal shape of what this needs from the Nest/Express app. */
export interface ProxyTrustTarget {
  set(setting: string, value: TrustProxySetting): unknown;
}

/**
 * Apply the setting and return the line to log. Extracted from bootstrap
 * so the WIRING is testable and not just the parse — the two failure
 * modes here are both silent, and "we set the right value on nothing"
 * is one of them.
 */
export function applyProxyTrust(
  app: ProxyTrustTarget,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const setting = resolveTrustProxy(env.TRUST_PROXY);
  app.set('trust proxy', setting);
  return describeTrustProxy(setting);
}
