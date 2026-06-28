import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { LeaderLeaseService } from './leader-lease.service';
import { JobReaperService, ReapResult } from './job-reaper.service';

/**
 * LeaseManagerService — cron-driven housekeeping for the queue.
 *
 *   - reapZombies sweep: every N seconds, find job_run rows whose
 *     status='running' AND leaseUntil<now() across every known tenant.
 *     Under maxAttempts → requeue with backoff; at-or-above → fail
 *     terminally with a synthetic ZombieAbandoned error.
 *
 *   - lease holder janitor: every M seconds, log the current
 *     leader_lease snapshot at debug level — surfaces stuck holders
 *     to operators without requiring the admin UI to be open.
 *
 * Runs on the leader pod only — gated by the `lease_manager_cron`
 * leader_lease so multi-pod deploys don't double-sweep (would still
 * be safe under CAS but wastes Surreal round-trips). A separate lease
 * key from `worker_loop` is intentional: the housekeeping cron should
 * survive even if the worker loop is wedged on a stuck handler — a
 * stuck dispatch must not prevent the reaper from clearing it.
 *
 * Cadence defaults: 10s reaper, 60s holder janitor. Tunable via
 * LEASE_MANAGER_REAP_CRON / LEASE_MANAGER_JANITOR_CRON env (cron
 * expressions). Per-tenant fan-out is bounded by the
 * SURREALDB_POOL_SIZE since each reap call holds one connection.
 */
@Injectable()
export class LeaseManagerService {
  private readonly logger = new Logger(LeaseManagerService.name);
  private readonly enabled: boolean;
  private reapInFlight = false;
  private janitorInFlight = false;

  constructor(
    config: ConfigService,
    private readonly reaper: JobReaperService,
    @Optional() private readonly lease?: LeaderLeaseService,
  ) {
    this.enabled =
      (config.get<string>('LEASE_MANAGER_ENABLED', '1') ?? '1') !== '0';
  }

  /**
   * Zombie reaper — every 10 seconds, sweep expired claims and
   * recycle them. The cadence balances:
   *   - too fast → wasted DB load when nothing has expired
   *   - too slow → stuck jobs block forward progress (a job whose
   *     pod died won't restart until reapZombies sees it)
   * Default ttl on a claim is 300s, so 10s gives ~30 ticks to
   * catch + recycle a dead worker within the lease window.
   */
  @Cron('*/10 * * * * *')
  async reapTick(): Promise<ReapResult | null> {
    if (!this.enabled) return null;
    if (this.reapInFlight) {
      // Previous tick still draining a large backlog. Skip silently —
      // the next tick will pick up what we couldn't.
      return null;
    }
    const isLeader = await this.acquireLease();
    if (!isLeader) return null;
    this.reapInFlight = true;
    try {
      return await this.reaper.reap();
    } catch (e) {
      this.logger.warn(`reapTick failed: ${(e as Error).message}`);
      return null;
    } finally {
      this.reapInFlight = false;
    }
  }

  /**
   * Holder janitor — every 60 seconds, snapshot leader_lease and log
   * at debug. Surfaces stuck holders to operators without forcing
   * them to refresh /admin/leases.
   */
  @Cron('0 * * * * *')
  async janitorTick(): Promise<void> {
    if (!this.enabled || this.janitorInFlight) return;
    if (!this.lease) return;
    this.janitorInFlight = true;
    try {
      const rows = await this.lease.list();
      if (rows.length === 0) return;
      const now = Date.now();
      const stuck = rows.filter((r) => {
        const expired = Date.parse(r.leaseUntil) < now;
        return expired;
      });
      if (stuck.length > 0) {
        this.logger.warn(
          `${stuck.length} expired lease(s) still in table: ${stuck
            .map((r) => `${r.name}@${r.leaderId}`)
            .join(', ')}`,
        );
      }
    } catch (e) {
      this.logger.warn(`janitorTick failed: ${(e as Error).message}`);
    } finally {
      this.janitorInFlight = false;
    }
  }

  private async acquireLease(): Promise<boolean> {
    if (!this.lease) return true; // single-process — always leader.
    try {
      // ttl=60s leaves plenty of headroom over the 10s cron cadence
      // so a brief GC pause doesn't cause repeated re-acquire churn.
      return await this.lease.tryAcquire('lease_manager_cron', 60);
    } catch (e) {
      this.logger.warn(
        `lease_manager_cron acquire failed: ${(e as Error).message}`,
      );
      return false;
    }
  }
}
