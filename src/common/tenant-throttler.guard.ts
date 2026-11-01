import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { envFlagEnabled } from '../common/env-validation';
import { CredentialResolverService } from '../auth/credential-resolver.service';
import { tierMultiplierFor, tokenTrackerKey } from '../auth/tier-multiplier';

/** The bearer token off a request, or null when the header is absent/malformed. */
/** The throttler name the failed-authentication budget is kept under. */
const AUTH_FAIL_THROTTLER = 'authfail';

/** A storage that can say a bucket is blocked without counting a hit (SurrealThrottlerStorage). */
interface BlockAwareStorage {
  isBlocked(key: string, throttlerName: string): Promise<boolean>;
}

function isBlockAware(storage: unknown): storage is BlockAwareStorage {
  return typeof (storage as Partial<BlockAwareStorage>).isBlocked === 'function';
}

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
 * A token that does not verify is bucketed by IP, not by its own hash:
 * keyed by the token, every random bearer got a fresh bucket and a flood
 * was never throttled at all. Failed verifications also count against a
 * per-IP budget (`authfail`, the default window's limit) that is checked
 * BEFORE verifying: an unknown `ik_` token costs a remote introspection
 * call, and the auth-service allows only so many, so a flood of junk
 * tokens used to exhaust that quota until real keys failed on a cache
 * miss (OWASP ASVS V2.2.1: throttle failed authentication by source).
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
    const token = bearerToken(req);
    const failKey = `ip:${(req.ip as string | undefined) ?? 'unknown'}`;
    const counts = requestProps.throttler.name === 'default';
    if (token && this.credentials && isBlockAware(this.storageService)) {
      if (await this.storageService.isBlocked(failKey, AUTH_FAIL_THROTTLER)) {
        throw new ThrottlerException();
      }
    }
    const verified = await this.verifiedRecord(req);
    if (token && this.credentials && verified === null && counts) {
      await this.storageService.increment(
        failKey,
        requestProps.ttl,
        requestProps.limit,
        requestProps.blockDuration,
        AUTH_FAIL_THROTTLER,
      );
    }
    const multiplier = verified ? tierMultiplierFor(verified.entitlements) : 1;
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
    // Only a verified credential earns a bucket of its own; the resolver
    // memoises on the request, so this is the verification already done.
    if (token && (!this.credentials || (await this.verifiedRecord(req)))) {
      return tokenTrackerKey(token);
    }
    const ip = (req.ip as string | undefined) ?? 'unknown';
    return `ip:${ip}`;
  }

  /**
   * The VERIFIED credential, null when the token does not verify, and
   * undefined when there is no token, no resolver, or the resolver failed.
   */
  private async verifiedRecord(
    req: Record<string, unknown>,
  ): Promise<{ entitlements?: readonly string[] | undefined } | null | undefined> {
    const token = bearerToken(req);
    if (!token || !this.credentials) return undefined;
    try {
      return await this.credentials.resolve(token, req);
    } catch {
      // A resolver failure (an auth-service outage) is the auth guard's to
      // report. It is not a failed authentication, so it spends nothing of
      // the caller's failed-auth budget; the request is bucketed by IP.
      return undefined;
    }
  }
}
