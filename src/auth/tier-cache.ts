/**
 * Verified-tier cache for tier-aware throttling.
 *
 * The throttler guard runs BEFORE the auth guard (global vs controller
 * guard order), so it cannot trust claims off the raw token — a forged
 * "enterprise" entitlement would widen the rate window for a credential
 * that never authenticates. Instead, CredentialResolverService records
 * the entitlement-derived multiplier here AFTER verification, keyed by
 * the same token hash the throttler tracks by. The first request of a
 * session runs at the default limit; every subsequent one gets the
 * verified tier. Pure module (no DI) — mirrors request-context.
 *
 * Multipliers come from THROTTLE_TIER_MULTIPLIERS, a JSON object mapping
 * entitlement slug → limit multiplier, e.g. {"plan:pro":2,"plan:team":5}.
 * A credential with several matching entitlements gets the largest one.
 */

import { createHash } from 'node:crypto';

const MAX_ENTRIES = 10_000;

const tiers = new Map<string, number>();

let parsedMultipliers: { src: string | undefined; map: Record<string, number> } | null =
  null;

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
 * The throttle tracker key for a bearer token — single source of truth
 * shared by TenantThrottlerGuard.getTracker and this cache, so the tier
 * lookup can never drift from the bucket key.
 */
export function tokenTrackerKey(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
  return `k:${digest}`;
}

/** Record the verified tier for a credential (post-authentication). */
export function recordTier(trackerKey: string, entitlements?: string[]): void {
  const map = multiplierMap();
  const multiplier = Math.max(
    1,
    ...(entitlements ?? []).map((e) => map[e] ?? 1),
  );
  if (multiplier <= 1) {
    tiers.delete(trackerKey);
    return;
  }
  if (tiers.size >= MAX_ENTRIES) {
    const oldest = tiers.keys().next().value;
    if (oldest !== undefined) tiers.delete(oldest);
  }
  tiers.set(trackerKey, multiplier);
}

/** Verified limit multiplier for a tracker key; 1 = default tier. */
export function tierMultiplier(trackerKey: string): number {
  return tiers.get(trackerKey) ?? 1;
}
