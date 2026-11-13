import { Logger } from '@nestjs/common';
import type { MigrationLock } from './migration-lock';

/**
 * Keeps the migration lease alive while a file runs.
 *
 * The migrator used to renew only BETWEEN files. One file that ran longer
 * than the TTL (a data backfill on a large tenant) let the lease lapse in
 * the middle of its own transaction: a second replica took the lease over
 * and applied the same file concurrently, and the first then failed with
 * "Lost migration lock" at the next file boundary. A timer renews the
 * lease every `intervalMs` regardless of what the migrator is awaiting.
 *
 * A renewal that comes back `false` means another process owns the lease
 * now — lost, at once. A renewal that THROWS (lease store briefly
 * unreachable) is not yet a loss: the lease we hold is still valid until
 * `validUntil`, so the heartbeat only gives up when the next tick would
 * land after that deadline. The migrator checks `assertHeld()` at every
 * file boundary and aborts cleanly there — an in-flight transaction cannot
 * be cancelled, but nothing new starts behind another holder's back.
 */
export class LeaseHeartbeat {
  private readonly logger = new Logger(LeaseHeartbeat.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private validUntil: number;
  private lostReason: string | undefined;

  constructor(
    private readonly lease: { lock: MigrationLock; name: string; ttlSeconds: number },
    private readonly intervalMs: number,
  ) {
    this.validUntil = Date.now() + lease.ttlSeconds * 1000;
  }

  /** Start renewing. The lease must already be held. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // One renewal at a time: a slow lease store must not stack them.
      if (this.inFlight || this.lostReason) return;
      this.inFlight = this.renew().finally(() => {
        this.inFlight = undefined;
      });
    }, this.intervalMs);
    // A migrator that is otherwise done must not keep the process alive.
    this.timer.unref();
  }

  /**
   * Stop renewing and wait for a renewal already on the wire, so a
   * release issued right after cannot be overtaken by a late renewal that
   * re-creates the lease.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  lost(): boolean {
    return this.lostReason !== undefined;
  }

  /** Throws when the lease is gone; `next` names what would have run. */
  assertHeld(next: string): void {
    if (this.lostReason === undefined) return;
    throw new Error(
      `Lost migration lock ${this.lease.name} before applying ${next} (${this.lostReason}) — ` +
        `refusing to write schema behind another replica's back`,
    );
  }

  private async renew(): Promise<void> {
    const { lock, name, ttlSeconds } = this.lease;
    const attemptedAt = Date.now();
    try {
      if (await lock.tryAcquire(name, ttlSeconds)) {
        this.validUntil = attemptedAt + ttlSeconds * 1000;
        return;
      }
      this.lostReason = 'another replica took the lease over';
    } catch (err) {
      if (Date.now() + this.intervalMs < this.validUntil) {
        this.logger.warn(
          `Renewing migration lock ${name} failed, retrying: ${(err as Error).message}`,
        );
        return;
      }
      this.lostReason = `renewal failed and the lease expires: ${(err as Error).message}`;
    }
    this.logger.error(`Migration lock ${name} lost: ${this.lostReason}`);
  }
}
