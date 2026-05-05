import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

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
 * Per-tier overrides: today every credential gets the same default
 * limit. When @inite/auth surfaces tier in the JWT (scopes or claim), the
 * matching path is `req.brainAuth.tier` → distinct ThrottlerOptions array
 * + per-tier @Throttle() decorators on the routes that need it.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers as Record<string, string> | undefined) ?? {};
    const auth = headers.authorization;
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
      return `k:${digest}`;
    }
    const ip = (req.ip as string | undefined) ?? 'unknown';
    return `ip:${ip}`;
  }
}
