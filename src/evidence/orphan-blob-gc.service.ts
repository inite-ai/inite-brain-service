import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Surreal } from 'surrealdb';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService, queryRows } from '../db/surreal.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';
import { InFlightGuard } from '../common/in-flight-guard';
import { MetricsService } from '../metrics/metrics.service';
import {
  orphanBlobGcDeleteEnabled,
  orphanBlobGcEnabled,
  orphanBlobGcGraceHours,
  orphanBlobGcMaxDeletions,
  orphanBlobGcScheduledEnabled,
  orphanBlobGcTimeBudgetMs,
} from '../common/evidence-flags';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageAdapter,
  type EvidenceStorageRegistry,
} from './storage/storage-adapter';

/**
 * How many enumerated refs are resolved against the DB in one round
 * trip. Each batch is ONE query per table, so the batch size trades
 * query count against parameter-list size; 200 keeps both small. It is a
 * constant, not a knob: an operator has no way to reason about a good
 * value, and neither correctness nor blast radius depends on it.
 */
const REF_BATCH = 200;

/** Orphan refs echoed back to the caller so a dry run is inspectable. */
const SAMPLE_LIMIT = 20;

/** Lock key for both the local and the distributed guard. */
const LOCK_KEY = 'evidence_orphan_blob_gc';

/**
 * Lease TTL for the distributed guard, matched to the DEFAULT whole-run
 * budget (the scene-maintenance rule): a lease shorter than the body it
 * protects expires mid-run and lets a second pod walk the same store.
 * Two concurrent orphan sweeps would not corrupt anything — the
 * pre-delete re-check and the ENOENT-tolerant delete make a double
 * unlink harmless — but they would double the walk and report each
 * other's work as failures.
 */
const LEASE_TTL_SECONDS = 10 * 60;

/** One tenant's slice of a run. */
export interface OrphanBlobGcTenantResult {
  companyId: string;
  /** True ⇒ nothing was unlinked, whatever the counts below say. */
  dryRun: boolean;
  /** Blobs the store offered for this tenant. */
  scanned: number;
  /** …of which a live evidence_asset row points at. */
  referenced: number;
  /** …of which the 0114 hard-erasure outbox has already condemned. */
  queued: number;
  /** …of which the grace window protects (bytes possibly still in flight). */
  young: number;
  /** …of which the adapter does not scope to this tenant (never touched). */
  foreign: number;
  /** Unreferenced, past grace: what a real run would (or did) delete. */
  orphans: number;
  /** Actually unlinked. Always 0 in a dry run. */
  deleted: number;
  /** Orphans that gained a reference between the scan and the delete. */
  raced: number;
  /** Delete failures — logged, counted, never fatal. */
  failed: number;
  /** Bytes the orphans occupy (what a real run would reclaim). */
  bytesReclaimable: number;
  /** Bytes actually reclaimed. */
  bytesDeleted: number;
  /** Interrupted-write artefacts found (fs: `.tmp-…` stragglers). */
  partialWrites: number;
  partialWritesRemoved: number;
  /** The per-tenant deletion cap stopped the run. */
  capReached: boolean;
  /** The wall-clock budget stopped the run. */
  budgetExhausted: boolean;
  durationSeconds: number;
  /** First few orphan refs — a dry run an operator can actually check. */
  sampleOrphans: string[];
  error?: string;
}

/** Whole-roster summary (the cron's return value). */
export interface OrphanBlobGcRunResult {
  tenants: OrphanBlobGcTenantResult[];
  budgetExhausted: boolean;
  /** Tenants never started because the budget ran out. */
  skippedForBudget: number;
}

const EMPTY_RUN: OrphanBlobGcRunResult = {
  tenants: [],
  budgetExhausted: false,
  skippedForBudget: 0,
};

/** Per-call overrides; both can only make a run MORE conservative. */
export interface OrphanBlobGcOptions {
  /** Force report-only even in stage two. Never the reverse. */
  dryRun?: boolean | undefined;
  /** Lower the deletion cap for this run. Never raises it. */
  maxDeletions?: number | undefined;
}

/** A blob the store offered, plus the age check already applied. */
interface Candidate {
  storageRef: string;
  byteLength: number;
}

/**
 * Everything one adapter's pass over one tenant needs, threaded as a
 * single value: the target, the store, the result being filled in, and
 * the bounds. Beyond keeping every leg to two arguments, this makes it
 * structurally impossible to hand one leg a tenant's result alongside
 * another tenant's adapter — the mistake that would matter here.
 */
interface Pass {
  companyId: string;
  adapter: EvidenceStorageAdapter;
  result: OrphanBlobGcTenantResult;
  limits: { deadline: number; maxDeletions: number; graceMs: number };
}

function emptyTenantResult(companyId: string, dryRun: boolean): OrphanBlobGcTenantResult {
  return {
    companyId,
    dryRun,
    scanned: 0,
    referenced: 0,
    queued: 0,
    young: 0,
    foreign: 0,
    orphans: 0,
    deleted: 0,
    raced: 0,
    failed: 0,
    bytesReclaimable: 0,
    bytesDeleted: 0,
    partialWrites: 0,
    partialWritesRemoved: 0,
    capReached: false,
    budgetExhausted: false,
    durationSeconds: 0,
    sampleOrphans: [],
  };
}

/**
 * EvidenceOrphanBlobGcService — the sweep that reclaims blobs no row
 * references (the honest follow-up the MM-7 upload PR named).
 *
 * THE LEAK. The upload path stores bytes BEFORE registering their row:
 *
 *     put(bytes) → registerAsset(storageRef) → scan → dispatch
 *
 * and when registerAsset throws it does NOT delete what it just wrote.
 * That is correct, not sloppy: put() is content-addressed, so identical
 * bytes from a second caller land on the SAME ref, and an eager unlink
 * on a failed registration could destroy bytes another row already owns.
 * The consequence is a leak with three sources — a failed registration,
 * a crashed request, a process killed mid-write — and an orphan blob is
 * inert but not free: it costs disk forever and it is media, which is
 * the one thing in this system that costs real money to store.
 *
 * WHAT AN ORPHAN IS, PRECISELY. A blob the store holds for tenant T such
 * that NO evidence_asset row in T's database has it as its storageRef,
 * and which is older than the grace window. Note what that definition
 * does NOT say:
 *   * it says nothing about the row's byteHash. A blob may back MORE
 *     THAN ONE row (registerAsset accepts an explicit storageRef whose
 *     hash is not the row's own), so the join key is storageRef and only
 *     storageRef — matching on hashes would delete a shared blob the
 *     moment its "own" row died;
 *   * it says nothing about the row's STATE. A quarantined row, a
 *     'gone' tombstone that still holds a ref because its blob delete
 *     failed, a row whose retention has expired but whose sweep has not
 *     run — every one of those is a reference, and a referenced blob is
 *     never an orphan. The reference query carries NO predicate beyond
 *     the ref match itself, deliberately;
 *   * it says nothing about the 0114 outbox. A ref the hard-erasure
 *     queue has already condemned belongs to that drainer, which deletes
 *     it unconditionally and tracks its own attempts; this sweep counts
 *     such refs and steps over them rather than racing for the same
 *     unlink.
 *
 * CROSS-TENANT SAFETY. This is a multi-tenant deployment where every
 * tenant is its OWN SurrealDB database (`co_<companyId>`), so there is
 * no query that can see all rows at once and none is attempted. Instead
 * the sweep is per-tenant on both sides of the join and the two sides
 * are pinned to the same tenant:
 *   * the roster comes from ApiKeyService.knownCompanyIds() — the same
 *     source every other maintenance pass walks. A blob directory
 *     belonging to a tenant that is NOT on the roster is never
 *     enumerated, so a deregistered tenant's bytes are left alone rather
 *     than silently destroyed;
 *   * the store side enumerates ONE tenant (adapter.listBlobs(companyId)),
 *     and the adapter contract requires every yielded ref to satisfy
 *     belongsToTenant — re-checked here per entry, so an adapter that
 *     cannot scope refs to a tenant collects nothing instead of
 *     collecting someone else's;
 *   * the row side runs inside surreal.withCompany(companyId) — that
 *     tenant's database and no other.
 * Because the ref is structurally the tenant's (fs://<companyId>/<hash>)
 * and registerAsset REFUSES a storageRef that does not belong to the
 * writing tenant, "no row in T references it" is the complete answer,
 * not a per-tenant approximation of one.
 *
 * WHY NO OUTBOX OF ITS OWN (and why 0114 is not extended). The 0114
 * queue exists because hard erasure destroys the only pointer to the
 * bytes: once the row is gone, a failed unlink is unrecoverable work
 * unless it was written down first. An orphan is the exact opposite —
 * it is DEFINED by having no pointer, so enumeration rediscovers it on
 * every run for free. A queue would add a second, weaker mechanism (a
 * condemned ref that a later upload legitimately reuses would be deleted
 * out from under the new row) to solve a problem that does not exist
 * here. So: no new table, no new migration, no new reason in the 0114
 * enum — this sweep READS that outbox to stay out of its way, and
 * nothing more.
 *
 * SAFETY LADDER, in the order it fires:
 *   1. EVIDENCE_ORPHAN_BLOB_GC off ⇒ nothing exists — no walk, no query;
 *   2. stage one REPORTS ONLY. Unlinking needs the separate
 *      EVIDENCE_ORPHAN_BLOB_GC_DELETE, and a caller's `dryRun: true` can
 *      only make a run more conservative;
 *   3. the grace window (default 24 h) protects any blob young enough to
 *      belong to an upload still in flight;
 *   4. the per-tenant deletion cap bounds the blast radius of a wrong
 *      answer; the wall-clock budget bounds the run;
 *   5. every orphan is RE-CHECKED against the rows immediately before
 *      its unlink, so a row registered during the walk saves its bytes;
 *   6. a delete failure is logged and counted; the run continues and the
 *      blob is rediscovered next time.
 * Idempotent and resumable by construction: a second run over a swept
 * store finds nothing, and an interrupted run loses only the work it had
 * not done.
 */
@Injectable()
export class EvidenceOrphanBlobGcService {
  private readonly logger = new Logger(EvidenceOrphanBlobGcService.name);
  /** Fallback reentrancy guard when JobsModule is not wired. */
  private readonly local = new InFlightGuard();

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly adapters: EvidenceStorageRegistry,
    // @Optional throughout (the evidence-module idiom): positionally
    // constructed unit fixtures stay valid; both modules are @Global in
    // production.
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  /**
   * Cron entry — 04:35 UTC. Every :0x–:5x slot of the 03:00 hour is
   * spoken for (recompose 03:05, compaction 03:17, memory quality 03:35,
   * outcome prune 03:41, calibration refit 03:42/03:51, candidate
   * sweeper 03:45, strategy distill 03:52), 04:00 is dreams and 04:20 is
   * scene maintenance. 04:35 is the first free slot after both LLM-heavy
   * passes, and clear of the hourly registry mirror (:26). Ordering
   * matters beyond tidiness: the candidate sweeper's evidence leg
   * (retention + the 0114 drain) runs at 03:45, so by 04:35 the rows it
   * was going to delete are gone and their blobs are already reclaimed —
   * this pass sees a settled store and reports the true residue.
   *
   * Both gates are checked BEFORE the lease so a disabled pass never
   * touches the lease table.
   */
  @Cron('35 4 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<OrphanBlobGcRunResult> {
    if (!orphanBlobGcEnabled() || !orphanBlobGcScheduledEnabled()) return EMPTY_RUN;
    const run = this.guard
      ? await this.guard.run(LOCK_KEY, () => this.runAll(), LEASE_TTL_SECONDS)
      : await this.local.run(LOCK_KEY, () => this.runAll());
    if (run === null) {
      this.logger.warn('orphan blob GC skipped — a previous run is still in flight');
      return EMPTY_RUN;
    }
    return run;
  }

  /**
   * Walk the tenant roster under the wall-clock budget. Public so the
   * admin route and tests can invoke the body without the guard; the
   * master flag is re-checked in sweepTenant, so an unguarded call
   * cannot sweep a disabled surface.
   */
  async runAll(opts: OrphanBlobGcOptions = {}): Promise<OrphanBlobGcRunResult> {
    const deadline = Date.now() + orphanBlobGcTimeBudgetMs();
    const result: OrphanBlobGcRunResult = {
      tenants: [],
      budgetExhausted: false,
      skippedForBudget: 0,
    };
    for (const companyId of this.apiKeys.knownCompanyIds()) {
      if (Date.now() >= deadline) {
        // Nothing is lost: an orphan is rediscovered by enumeration on
        // the next run. Count what we did not start rather than drop it.
        result.budgetExhausted = true;
        result.skippedForBudget += 1;
        this.metrics?.countEvidenceOrphanGc('skipped_budget');
        continue;
      }
      result.tenants.push(await this.sweepTenant(companyId, { ...opts, deadline }));
    }
    return result;
  }

  /**
   * Sweep ONE tenant. Never throws: a tenant that fails is reported with
   * its `error` and the roster continues (the dreams fan-out rule).
   * Returns a zeroed result — not an error — while the flag is off, so a
   * disabled sweep is indistinguishable from a clean one to a counter.
   */
  async sweepTenant(
    companyId: string,
    opts: OrphanBlobGcOptions & { deadline?: number } = {},
  ): Promise<OrphanBlobGcTenantResult> {
    const startedAt = Date.now();
    const result = emptyTenantResult(companyId, this.dryRun(opts));
    if (!orphanBlobGcEnabled()) return result;
    const deadline = opts.deadline ?? startedAt + orphanBlobGcTimeBudgetMs();
    const maxDeletions = Math.min(
      orphanBlobGcMaxDeletions(),
      opts.maxDeletions !== undefined && opts.maxDeletions > 0 ? opts.maxDeletions : Infinity,
    );
    const limits = { deadline, maxDeletions, graceMs: orphanBlobGcGraceHours() * 3600_000 };
    try {
      for (const adapter of this.adapters.values()) {
        if (result.budgetExhausted || result.capReached) break;
        await this.sweepAdapter({ companyId, adapter, result, limits });
      }
    } catch (e) {
      // Per-tenant isolation: an unreadable store or a Surreal hiccup on
      // tenant N must not cost tenant N+1 its run. Whatever the pass had
      // already counted stays in the result — a partial report is more
      // useful than a discarded one.
      result.error = (e as Error).message;
      this.logger.warn(`orphan blob GC failed for ${companyId}: ${result.error}`);
    }
    result.durationSeconds = (Date.now() - startedAt) / 1000;
    this.report(result);
    return result;
  }

  /** Effective dry-run: the flag decides, the caller may only tighten. */
  private dryRun(opts: OrphanBlobGcOptions): boolean {
    return opts.dryRun === true || !orphanBlobGcDeleteEnabled();
  }

  /**
   * One adapter's contribution. An adapter without listBlobs is skipped
   * silently and completely — it has not promised tenant-scoped
   * enumeration, so nothing it holds may be judged (the storage-adapter
   * contract point).
   */
  private async sweepAdapter(pass: Pass): Promise<void> {
    const { adapter, companyId, result, limits } = pass;
    await this.sweepPartialWrites(pass);
    if (!adapter.listBlobs) return;
    const cutoff = Date.now() - limits.graceMs;
    let batch: Candidate[] = [];
    for await (const entry of adapter.listBlobs(companyId)) {
      result.scanned += 1;
      if (!adapter.belongsToTenant(companyId, entry.storageRef)) {
        // Defence in depth behind the adapter's own promise: a ref this
        // tenant does not own cannot be judged against this tenant's
        // rows, so it is counted and left entirely alone.
        result.foreign += 1;
        continue;
      }
      if (entry.modifiedAtMs > cutoff) {
        result.young += 1;
        continue;
      }
      batch.push({ storageRef: entry.storageRef, byteLength: entry.byteLength });
      if (batch.length >= REF_BATCH) {
        await this.resolveBatch(pass, batch);
        batch = [];
        if (this.stop(result, limits)) return;
      }
    }
    if (batch.length > 0) await this.resolveBatch(pass, batch);
    this.stop(result, limits);
  }

  /** Interrupted-write debris — no ref, no row, its own broom. */
  private async sweepPartialWrites(pass: Pass): Promise<void> {
    const { adapter, companyId, result, limits } = pass;
    if (!adapter.sweepIncompleteWrites) return;
    const swept = await adapter.sweepIncompleteWrites(companyId, {
      olderThanMs: limits.graceMs,
      dryRun: result.dryRun,
    });
    result.partialWrites += swept.found;
    result.partialWritesRemoved += swept.removed;
  }

  /**
   * Resolve one batch of candidates against the tenant's rows, then
   * delete what survives the checks. ONE round trip per batch, two
   * queries inside it:
   *
   *   * evidence_asset — the reference set. `storageRef INSIDE $refs`
   *     with no other predicate: every row state counts as a reference
   *     (see the class docblock). This is a SELECT, so the 3.2.4
   *     compound-planner DELETE/UPDATE hazard does not apply — and the
   *     sweep issues no DELETE against any table at all;
   *   * evidence_blob_gc — refs the 0114 hard-erasure drainer already
   *     owns, stepped over rather than raced for.
   */
  private async resolveBatch(pass: Pass, batch: Candidate[]): Promise<void> {
    const { companyId, result, limits } = pass;
    const refs = batch.map((c) => c.storageRef);
    const { referenced, queued } = await this.surreal.withCompany(companyId, async (db) => ({
      referenced: await this.refsIn(db, 'evidence_asset', refs),
      queued: await this.refsIn(db, 'evidence_blob_gc', refs),
    }));
    for (const candidate of batch) {
      if (referenced.has(candidate.storageRef)) {
        result.referenced += 1;
        continue;
      }
      if (queued.has(candidate.storageRef)) {
        result.queued += 1;
        continue;
      }
      result.orphans += 1;
      result.bytesReclaimable += candidate.byteLength;
      if (result.sampleOrphans.length < SAMPLE_LIMIT) {
        result.sampleOrphans.push(candidate.storageRef);
      }
      if (result.dryRun || this.stop(result, limits)) continue;
      await this.deleteOrphan(pass, candidate);
    }
  }

  /** The set of refs from `refs` that this table currently holds. */
  private async refsIn(db: Surreal, table: string, refs: string[]): Promise<Set<string>> {
    const rows = await queryRows<unknown>(
      db,
      `SELECT VALUE storageRef FROM ${table} WHERE storageRef INSIDE $refs`,
      { refs },
    );
    return new Set(rows.map(String));
  }

  /**
   * Unlink one orphan, with the last-moment re-check that makes the
   * whole pass safe to run against a live system: between the batch
   * resolve and this call a row may have been registered against these
   * bytes (put() is idempotent, so a fresh upload of identical content
   * reuses the existing blob and then registers). Re-reading the rows
   * per blob costs one indexed-free scan and buys the difference between
   * a hygiene pass and a data-loss bug.
   *
   * A failure — a permission problem, a vanished directory, an adapter
   * throw — is logged and counted. Never fatal: the run continues and
   * enumeration rediscovers the blob next time.
   */
  private async deleteOrphan(pass: Pass, candidate: Candidate): Promise<void> {
    const { adapter, companyId, result } = pass;
    try {
      const stillFree = await this.surreal.withCompany(companyId, async (db) => {
        const rows = await this.refsIn(db, 'evidence_asset', [candidate.storageRef]);
        return rows.size === 0;
      });
      if (!stillFree) {
        result.raced += 1;
        return;
      }
      const removed = await adapter.delete(candidate.storageRef);
      // `false` is "already gone" (ENOENT) — someone else won the race
      // to the same unlink, which is the outcome we wanted anyway.
      if (removed) {
        result.deleted += 1;
        result.bytesDeleted += candidate.byteLength;
      }
    } catch (e) {
      result.failed += 1;
      this.logger.warn(
        `orphan blob delete failed for ${candidate.storageRef}: ${(e as Error).message}`,
      );
    }
  }

  /** True once a bound has bitten; stamps which one, for the report. */
  private stop(
    result: OrphanBlobGcTenantResult,
    limits: { deadline: number; maxDeletions: number },
  ): boolean {
    if (result.deleted >= limits.maxDeletions) result.capReached = true;
    if (Date.now() >= limits.deadline) result.budgetExhausted = true;
    return result.capReached || result.budgetExhausted;
  }

  /** One log line + counters per tenant; silent on a clean, empty pass. */
  private report(result: OrphanBlobGcTenantResult): void {
    this.metrics?.countEvidenceOrphanGc(
      result.error !== undefined ? 'failed' : result.dryRun ? 'dry_run' : 'ok',
    );
    this.metrics?.countEvidenceOrphanBlobs('scanned', result.scanned);
    this.metrics?.countEvidenceOrphanBlobs('orphan', result.orphans);
    this.metrics?.countEvidenceOrphanBlobs('deleted', result.deleted);
    this.metrics?.countEvidenceOrphanBlobs('failed', result.failed);
    this.metrics?.observeEvidenceOrphanGcDuration(result.durationSeconds);
    if (result.orphans === 0 && result.partialWrites === 0 && result.error === undefined) return;
    this.logger.log(
      `orphan blob GC ${result.companyId}${result.dryRun ? ' (dry run)' : ''}: ` +
        `scanned=${result.scanned} referenced=${result.referenced} queued=${result.queued} ` +
        `young=${result.young} orphans=${result.orphans} deleted=${result.deleted} ` +
        `raced=${result.raced} failed=${result.failed} ` +
        `bytes=${result.dryRun ? result.bytesReclaimable : result.bytesDeleted} ` +
        `partial=${result.partialWritesRemoved}/${result.partialWrites}` +
        `${result.capReached ? ' cap-reached' : ''}${result.budgetExhausted ? ' budget-exhausted' : ''}`,
    );
  }
}
