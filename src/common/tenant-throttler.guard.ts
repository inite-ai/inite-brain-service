import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { envFlagEnabled } from '../common/env-validation';
import { tierMultiplier, tokenTrackerKey } from '../auth/tier-cache';

/**
 * Per-credential rate limiter.
 *
 * The default ThrottlerGuard tracks by IP, which is the wrong key for a
 * multi-tenant API: one tenant behind a NAT can throttle another. We key
 * by the Bearer token instead — same key → same bucket, different keys →
 * different buckets. We hash the token (truncated SHA-256) so the tracker
 * is bounded length and never embeds the secret in metrics or memory dumps.
 *
 * Unauthenticated requests still fall through to IP. They never get past
 * the ApiKeyGuard anyway, but bucketing them by IP prevents an unauth
 * flood from spending one tenant's quota.
 *
 * Per-tier limits: the auth-service stamps plan entitlements on issued
 * tokens; after verification the resolver records the entitlement-derived
 * multiplier in the tier cache (keyed by the same tracker key), and
 * handleRequest scales the bucket limit by it. Claims are never read off
 * the raw token here — this guard runs before authentication, and an
 * unverified "enterprise" claim must not widen anyone's window.
 * Configure via THROTTLE_TIER_MULTIPLIERS (see tier-cache.ts).
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  /**
   * Global off-switch. Per-route @Throttle() decorators hardcode their
   * own limits, which the THROTTLE_*_LIMIT env knobs can't override, so
   * e2e suites that legitimately fire >N expensive calls would 429.
   * THROTTLE_DISABLED=1 (set only by the test fixture) skips throttling
   * entirely. Never set in production.
   */
  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    // Inert in production even if the flag leaks into a deploy env —
    // validateEnv also hard-errors on it at boot. Defense in depth: a
    // stray THROTTLE_DISABLED must never silently drop the expensive
    // OpenAI-budget caps in prod.
    if (
      envFlagEnabled(process.env.THROTTLE_DISABLED) &&
      process.env.NODE_ENV !== 'production'
    ) {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const req = requestProps.context.switchToHttp().getRequest();
    const tracker = await this.getTracker(req);
    const multiplier = tierMultiplier(tracker);
    if (multiplier > 1) {
      return super.handleRequest({
        ...requestProps,
        limit: Math.ceil(requestProps.limit * multiplier),
      });
    }
    return super.handleRequest(requestProps);
  }

  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const headers = (req.headers as Record<string, string> | undefined) ?? {};
    const auth = headers.authorization;
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      return tokenTrackerKey(auth.slice(7).trim());
    }
    const ip = (req.ip as string | undefined) ?? 'unknown';
    return `ip:${ip}`;
  }
}
