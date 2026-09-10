/**
 * Tier-aware throttling, as pure functions of the VERIFIED credential.
 *
 * The throttler guard runs before the auth guard and must not trust
 * claims off the raw token, so it resolves the credential itself (the
 * resolver memoises the result on the request for the auth guard) and
 * scales the bucket limit by the entitlement-derived multiplier here.
 * No cache: the multiplier is derived on every request from the record
 * the resolver already holds, so a `plan:team` credential gets its
 * window on its FIRST request on every replica.
 *
 * Multipliers come from THROTTLE_TIER_MULTIPLIERS, a JSON object mapping
 * entitlement slug → limit multiplier, e.g. {"plan:pro":2,"plan:team":5}.
 * A credential with several matching entitlements gets the largest one.
 */

import { createHash } from 'node:crypto';

let parsedMultipliers: { src: string | undefined; map: Record<string, number> } | null = null;

function multiplierMap(): Record<string, number> {
  const src = process.env.THROTTLE_TIER_MULTIPLIERS;
  if (parsedMultipliers && parsedMultipliers.src === src) return parsedMultipliers.map;
  let map: Record<string, number> = {};
  if (src) {
    try {
      const raw = JSON.parse(src) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1 && n <= 100) map[k] = n;
      }
    } catch {
      map = {};
    }
  }
  parsedMultipliers = { src, map };
  return map;
}

/**
 * The throttle tracker key for a bearer token: truncated SHA-256, so the
 * bucket key is bounded and never embeds the secret.
 */
export function tokenTrackerKey(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return `k:${digest}`;
}

/** Limit multiplier for a verified credential's entitlements; 1 = default tier. */
export function tierMultiplierFor(entitlements?: readonly string[]): number {
  const map = multiplierMap();
  return Math.max(1, ...(entitlements ?? []).map((e) => map[e] ?? 1));
}
