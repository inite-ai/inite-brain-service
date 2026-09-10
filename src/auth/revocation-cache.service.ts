import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';

/** How stale this process's copy of the shared deny-list may be. */
const COHERENCE_MS = 5_000;
/** How often one process sweeps expired denials out of the shared table. */
const GC_INTERVAL_MS = 10 * 60_000;

interface RevokedRow {
  subject: string;
  expiresAt: string | Date;
}

/**
 * Deny-list of revoked subjects, fed by the SSF receiver (CAEP
 * session-revoked / account-disabled / token-claims-change events from
 * the auth-service).
 *
 * Why it exists: brain verifies JWTs locally against the JWKS, so a
 * revoked-at-the-IdP token stays valid here until `exp`. The deny-list
 * closes that window to the SSF poll interval. Entries expire after the
 * max access-token lifetime — past that the token itself is dead.
 *
 * Shared across replicas: poll delivery is an acked queue, so only the
 * replica that consumed a SET learns of it. deny() therefore persists
 * the subject to `revoked_subject` in the system database (migration
 * 0141) and every replica's isDenied() reads through its process-local
 * map, refreshed from that table at most once per COHERENCE_MS — one
 * small read per five seconds per process, nothing per request. A
 * failed refresh keeps serving the local map and is logged. Rows past
 * their expiry are swept from that same pull path, at most once per
 * GC_INTERVAL_MS per process — no cron.
 *
 * Without a SurrealService (unit fixtures) it is the local map alone.
 */
@Injectable()
export class RevocationCacheService {
  private readonly logger = new Logger(RevocationCacheService.name);
  private readonly denied = new Map<string, number>();
  private lastPullAt = 0;
  private lastGcAt = 0;
  private pulling: Promise<void> | null = null;

  /** Covers the auth-service user access-token TTL (10m) with margin. */
  static readonly DEFAULT_TTL_MS = 15 * 60_000;
  private static readonly MAX_ENTRIES = 10_000;

  constructor(@Optional() private readonly surreal?: SurrealService) {}

  /**
   * Deny `subject` for `ttlMs`, locally at once and in the shared table.
   * Rejects when the shared write fails — the caller decides whether the
   * event may be acknowledged (the SSF receiver does not, so the SET is
   * redelivered and persisted on a later poll).
   */
  async deny(
    subject: string,
    ttlMs: number = RevocationCacheService.DEFAULT_TTL_MS,
    reason?: string,
  ): Promise<void> {
    if (!subject) return;
    const until = Date.now() + ttlMs;
    this.denyLocal(subject, until);
    this.logger.log(`Subject deny-listed for ${Math.round(ttlMs / 1000)}s`);
    // An already-expired entry has nothing to share.
    if (!this.surreal || ttlMs <= 0) return;
    const sets = [
      'subject = $subject',
      'revokedAt = time::now()',
      'expiresAt = type::datetime($until)',
    ];
    const vars: Record<string, unknown> = { subject, until: new Date(until).toISOString() };
    if (reason !== undefined) {
      sets.push('reason = $reason');
      vars.reason = reason;
    }
    await this.surreal.withAdminDb(async (db) => {
      await db.query(
        `UPSERT type::record('revoked_subject', $subject) SET ${sets.join(', ')}`,
        vars,
      );
    });
  }

  /** Is `subject` denied, as of at most COHERENCE_MS ago across the fleet. */
  async isDenied(subject: string): Promise<boolean> {
    await this.pullIfStale();
    return this.isDeniedLocally(subject);
  }

  /** This process's view only — what the last refresh (or deny) left here. */
  isDeniedLocally(subject: string): boolean {
    const until = this.denied.get(subject);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.denied.delete(subject);
      return false;
    }
    return true;
  }

  /** Merge every live row of the shared table into the local map. */
  async refresh(): Promise<void> {
    if (!this.surreal) return;
    this.lastPullAt = Date.now();
    const rows = await this.surreal.withAdminDb((db) =>
      queryRows<RevokedRow>(
        db,
        `SELECT subject, expiresAt FROM revoked_subject WHERE expiresAt > time::now()`,
      ),
    );
    for (const row of rows) {
      if (!row.subject) continue;
      const until = new Date(row.expiresAt).getTime();
      if (Number.isFinite(until)) this.denyLocal(row.subject, until);
    }
    this.sweepIfDue();
  }

  /**
   * Delete denials whose expiry has passed — the token each one covered
   * is dead by then. Public so a spec can drive it; production calls it
   * from the pull path. Returns the number of rows removed.
   */
  async sweepExpired(): Promise<number> {
    if (!this.surreal) return 0;
    return this.surreal.withAdminDb(async (db) => {
      // SELECT-ids-then-DELETE: the 3.2.4 discipline (an index-served
      // DELETE … WHERE can silently match zero rows).
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM revoked_subject WHERE expiresAt <= time::now() LIMIT 5000`,
      );
      if (ids.length === 0) return 0;
      await db.query(`DELETE $ids`, { ids });
      return ids.length;
    });
  }

  private pullIfStale(): Promise<void> {
    if (!this.surreal || Date.now() - this.lastPullAt < COHERENCE_MS) return Promise.resolve();
    if (!this.pulling) {
      this.pulling = this.refresh()
        .catch((e) => {
          this.logger.warn(
            `revoked_subject refresh failed, serving the local deny-list: ${(e as Error).message}`,
          );
        })
        .finally(() => {
          this.pulling = null;
        });
    }
    return this.pulling;
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastGcAt < GC_INTERVAL_MS) return;
    this.lastGcAt = now;
    void this.sweepExpired()
      .then((n) => {
        if (n > 0) this.logger.debug(`Swept ${n} expired revocation(s)`);
      })
      .catch((e) => this.logger.warn(`revoked_subject sweep failed: ${(e as Error).message}`));
  }

  private denyLocal(subject: string, until: number): void {
    const existing = this.denied.get(subject);
    if (existing !== undefined && existing >= until) return;
    this.prune();
    if (this.denied.size >= RevocationCacheService.MAX_ENTRIES) {
      const oldest = this.denied.keys().next().value;
      if (oldest !== undefined) this.denied.delete(oldest);
    }
    this.denied.set(subject, until);
  }

  private prune(): void {
    if (this.denied.size < RevocationCacheService.MAX_ENTRIES) return;
    const now = Date.now();
    for (const [sub, until] of this.denied) {
      if (until <= now) this.denied.delete(sub);
    }
  }
}
