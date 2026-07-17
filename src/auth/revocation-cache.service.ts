import { Injectable, Logger } from '@nestjs/common';

/**
 * In-memory deny-list of revoked subjects, fed by the SSF receiver
 * (CAEP session-revoked / account-disabled / token-claims-change events
 * from the auth-service).
 *
 * Why it exists: brain verifies JWTs locally against the JWKS, so a
 * revoked-at-the-IdP token stays valid here until `exp`. The deny-list
 * closes that window to the SSF poll interval. Entries expire after the
 * max access-token lifetime — past that the token itself is dead and
 * the entry is dead weight.
 *
 * Single-process cache by design (matches the tenant throttler): each
 * replica polls the stream independently.
 */
@Injectable()
export class RevocationCacheService {
  private readonly logger = new Logger(RevocationCacheService.name);
  private readonly denied = new Map<string, number>();

  /** Covers the auth-service user access-token TTL (10m) with margin. */
  static readonly DEFAULT_TTL_MS = 15 * 60_000;
  private static readonly MAX_ENTRIES = 10_000;

  deny(subject: string, ttlMs: number = RevocationCacheService.DEFAULT_TTL_MS): void {
    if (!subject) return;
    this.prune();
    if (this.denied.size >= RevocationCacheService.MAX_ENTRIES) {
      const oldest = this.denied.keys().next().value;
      if (oldest !== undefined) this.denied.delete(oldest);
    }
    this.denied.set(subject, Date.now() + ttlMs);
    this.logger.log(`Subject deny-listed for ${Math.round(ttlMs / 1000)}s`);
  }

  isDenied(subject: string): boolean {
    const until = this.denied.get(subject);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.denied.delete(subject);
      return false;
    }
    return true;
  }

  private prune(): void {
    if (this.denied.size < RevocationCacheService.MAX_ENTRIES) return;
    const now = Date.now();
    for (const [sub, until] of this.denied) {
      if (until <= now) this.denied.delete(sub);
    }
  }
}
