import { Injectable, Logger, Optional } from '@nestjs/common';
import { LeaderLeaseService } from '../jobs/leader-lease.service';
import { InFlightGuard } from './in-flight-guard';

/**
 * Drop-in replacement for InFlightGuard with the same `.run(key, fn)`
 * shape, but the lock-key resolves to a distributed lease in the
 * SurrealDB `leader_lease` table (migration 0029).
 *
 * Falls back to local in-flight guard when LeaderLeaseService is
 * unavailable (DI optional makes it harmless in unit tests that
 * don't wire JobsModule).
 *
 * The cron sites (Dreams, Compaction, CalibrationRefit, Changefeed)
 * keep their existing `guard.run('all', () => …)` call shape; behind
 * the scenes the lease takes ttlSeconds=300 (5 min) — enough for a
 * compaction run to finish. Cron jobs whose body might run longer
 * than 5 min should pass an explicit larger ttl.
 */
@Injectable()
export class DistributedLeaseGuard {
  private readonly logger = new Logger(DistributedLeaseGuard.name);
  private readonly local = new InFlightGuard();

  constructor(@Optional() private readonly lease?: LeaderLeaseService) {}

  /**
   * Run `fn` exclusively for `key` across the fleet. Returns null
   * when another pod (or another in-flight call on this pod) holds
   * the lease — caller's cron should log and return early.
   *
   * `ttlSeconds` controls how long the lease is held; release on
   * completion is automatic. Pick a value comfortably longer than
   * the worst-case body duration.
   */
  async run<T>(
    key: string,
    fn: () => Promise<T>,
    ttlSeconds = 300,
  ): Promise<T | null> {
    // Local reentrancy first — cheap and protects same-pod overlap
    // (cron + manual trigger landing simultaneously).
    return this.local.run(key, async () => {
      if (this.lease) {
        const got = await this.lease.tryAcquire(key, ttlSeconds);
        if (!got) {
          this.logger.log(
            `lease ${key} held by another pod — skipping cron`,
          );
          return null;
        }
        try {
          return (await fn()) as T;
        } finally {
          // Best-effort release. If we crash, leaseUntil expires and
          // the next pod acquires naturally.
          await this.lease.release(key);
        }
      }
      // No lease service wired — degrade to local-only behaviour.
      return fn();
    }) as Promise<T | null>;
  }
}
