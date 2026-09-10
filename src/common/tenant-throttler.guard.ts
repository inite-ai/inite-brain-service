import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { envFlagEnabled } from '../common/env-validation';
import { CredentialResolverService } from '../auth/credential-resolver.service';
import { tierMultiplierFor, tokenTrackerKey } from '../auth/tier-multiplier';

/** The bearer token off a request, or null when the header is absent/malformed. */
function bearerToken(req: Record<string, unknown>): string | null {
  const headers = (req.headers as Record<string, string> | undefined) ?? {};
  const auth = headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

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
 * Per-tier limits: this guard runs before authentication, so it never
 * reads claims off the raw token — an unverified "enterprise" claim must
 * not widen anyone's window. Instead it resolves the credential through
 * CredentialResolverService (memoised on the request, so the auth guard
 * does not verify twice) and scales the bucket limit by the verified
 * entitlements on every request, on every replica. The resolver is
 * property-injected because ThrottlerGuard's constructor is already at
 * the three-dependency cap. Configure via THROTTLE_TIER_MULTIPLIERS.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(CredentialResolverService)
  protected credentials?: CredentialResolverService;

  /**
   * Global off-switch. Per-route @Throttle() decorators hardcode their
   * own limits, which the THROTTLE_*_LIMIT env knobs can't override, so
   * e2e suites that legitimately fire >N expensive calls would 429.
   * THROTTLE_DISABLED=1 (set only by the test fixture) skips throttling
   * entirely. Never set in production.
   */
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    // Inert in production even if the flag leaks into a deploy env —
    // validateEnv also hard-errors on it at boot. Defense in depth: a
    // stray THROTTLE_DISABLED must never silently drop the expensive
    // OpenAI-budget caps in prod.
    if (envFlagEnabled(process.env.THROTTLE_DISABLED) && process.env.NODE_ENV !== 'production') {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const req = requestProps.context.switchToHttp().getRequest();
    const multiplier = await this.verifiedTierMultiplier(req);
    if (multiplier > 1) {
      return super.handleRequest({
        ...requestProps,
        limit: Math.ceil(requestProps.limit * multiplier),
      });
    }
    return super.handleRequest(requestProps);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const token = bearerToken(req);
    if (token) return tokenTrackerKey(token);
    const ip = (req.ip as string | undefined) ?? 'unknown';
    return `ip:${ip}`;
  }

  /** Multiplier from the VERIFIED credential; default tier when there is none. */
  private async verifiedTierMultiplier(req: Record<string, unknown>): Promise<number> {
    const token = bearerToken(req);
    if (!token || !this.credentials) return 1;
    try {
      const record = await this.credentials.resolve(token, req);
      return tierMultiplierFor(record?.entitlements);
    } catch {
      // A resolver failure is the auth guard's to report; here it only
      // means the default tier.
      return 1;
    }
  }
}
