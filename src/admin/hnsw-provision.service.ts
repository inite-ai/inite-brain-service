import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { TenantRegistryService, type TenantIndexStateRow } from '../auth/tenant-registry.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';
import { InFlightGuard } from '../common/in-flight-guard';
import { envFlagEnabled } from '../common/env-validation';
import { HnswMaintenanceService, type HnswMaintenanceResult } from './hnsw-maintenance.service';

/**
 * HnswProvisionService — the missing half of the HNSW story.
 *
 * THE GAP. Production sets SEARCH_HNSW_ENABLED=1 globally
 * (deploy-brain.yml), and until this service existed
 * `HnswMaintenanceService.apply` had exactly ONE caller in the repository:
 * the admin route. No provisioning hook, no deploy step, no script, and
 * nothing that recorded which tenants had indexes. Every tenant onboarded
 * since the last manual sweep started without one — and #506 measured what
 * that is: SurrealDB does not fail a `<|K,EF|>` query with no index to ride,
 * it drops the operator from the plan and returns k arbitrary rows with a
 * NULL distance. The sharpest consequence is inline entity resolution,
 * where `sim = 0` breaks the loop below `cosineFloor`, so an un-indexed
 * tenant reuses no entity and mints a duplicate for every mention. #506 made
 * that state self-reporting. It did not stop new tenants entering it.
 *
 * WHERE PROVISIONING ACTUALLY HAPPENS. Not at "registry install" — there
 * is no onboarding route; TenantRegistryService.register() has zero
 * production callers and `status:'provisioning'` is never written. Not at
 * an explicit migration step — there is no standalone migrate command.
 * A tenant comes into existence in exactly one place:
 * SurrealService.ensureSchema(), which runs `DEFINE NAMESPACE` /
 * `DEFINE DATABASE` and then applies every numbered migration, once per
 * database, triggered by the first request that enters that tenant's scope.
 * That is the hook, and this service takes it via
 * `surreal.onTenantSchemaReady()`.
 *
 * WHY THE HOOK ONLY *NOTES* THE TENANT. ensureSchema runs inside the global
 * schema-apply queue, on the first request for that tenant, on the migrator
 * connection every other tenant's first request is queued behind. Emitting
 * index DDL there would put a build on the critical path of a user request
 * and serialise every other tenant behind it. So the hook does the cheapest
 * possible thing — push the id onto a set — and a drain loop with a
 * concurrency of ONE does the work off the request path.
 *
 * WHY THE HOOK IS NOT ENOUGH, AND THE SWEEP IS NOT ENOUGH EITHER.
 *   * The hook fires once per (process, tenant). It cannot see a tenant
 *     that has not been touched since the last restart, and it cannot see
 *     an index that was dropped after the process learned the tenant.
 *   * The nightly sweep walks the whole roster and converges it, but a
 *     brand-new tenant would wait up to a day for its first index —
 *     precisely the window in which it is ingesting its first corpus and
 *     minting the duplicates.
 * Together they cover both: new tenants are indexed within seconds of
 * existing, and the roster is reconciled every night regardless.
 *
 * WHY NOT AT BOOT. A reconciliation pass over the whole roster at startup
 * is a stampede with a rollout multiplier: every pod runs it, at the same
 * moment, on a fleet that is by definition mid-deploy — and the failure it
 * would cause (N tenants × 4 concurrent index builds against one SurrealDB)
 * looks exactly like the deploy being bad. The nightly sweep is
 * leader-elected, budgeted and capped; the lazy hook staggers itself
 * naturally by traffic. Neither of them fires because a process started.
 *
 * BLAST RADIUS, made small on purpose:
 *   * `ensure`, never `create` — no REMOVE, so a working index is never
 *     dropped and a build in flight is never restarted;
 *   * CONCURRENTLY always, so the DDL returns in ~20 ms and the build runs
 *     server-side (the synchronous path is not slower, it FAILS: 133 s and
 *     a RocksDB transaction conflict over 20k × 1024-d, #507);
 *   * one tenant at a time per process, with a stagger between tenants that
 *     actually emitted DDL;
 *   * a per-run cap on how many tenants may START builds
 *     (HNSW_PROVISION_MAX_BUILDS_PER_RUN), so the first night after
 *     enablement converges over several nights instead of in one thundering
 *     pass;
 *   * a wall-clock budget on the roster walk;
 *   * per-tenant error isolation (the dreams fan-out rule).
 *
 * WHAT IT RECORDS. Every observation lands in `tenant_registry`
 * (indexState / indexDetail / indexStateAt / embeddingSpace), so
 * "which tenants have a ready index" is one SELECT against the system
 * database — no DDL, no per-tenant round trip — and a Prometheus gauge
 * carries the same fold for alerting.
 */

/** One tenant's outcome in a reconciliation pass. */
export interface HnswProvisionTenantResult {
  companyId: string;
  /** The recorded fold: ready | building | partial | absent | mismatch | unknown. */
  state: HnswProvisionState;
  /** Indexes this pass DEFINEd. Empty when nothing needed doing. */
  created: string[];
  /** True when every index is ready at the embedder's width. */
  ready: boolean;
  error?: string;
}

/** Whole-roster summary — the cron's return value and the admin response. */
export interface HnswProvisionRunResult {
  tenants: HnswProvisionTenantResult[];
  /** True when the wall-clock budget stopped the roster walk early. */
  budgetExhausted: boolean;
  /** Tenants never started because the budget ran out. */
  skippedForBudget: number;
  /**
   * Tenants left un-provisioned because the per-run build cap was reached.
   * They were still PROBED and recorded — the cap bounds DDL, not
   * visibility, so the roster tells the truth about them tonight and the
   * next run picks them up.
   */
  skippedForCap: number;
  /** True when no DDL was emitted because the caller asked for a dry run. */
  dryRun: boolean;
}

export type HnswProvisionState =
  'ready' | 'building' | 'partial' | 'absent' | 'mismatch' | 'unknown';

export interface HnswProvisionOptions {
  /** Probe and record, emit no DDL. The default for a first look. */
  dryRun?: boolean;
  /** Restrict the walk to these tenants (admin scope, tests). */
  tenants?: readonly string[];
}

const LOCK_KEY = 'hnsw_provision_all';

/**
 * Lease TTL for the nightly sweep. Comfortably longer than the default
 * wall-clock budget (10 min) so the lease cannot expire mid-walk and let a
 * second pod start a parallel pass — two pods racing DEFINE INDEX on the
 * same tenant is the one way this sweep could hurt.
 */
const LEASE_TTL_SECONDS = 20 * 60;

const DEFAULT_TIME_BUDGET_MS = 10 * 60_000;
/**
 * How many tenants may START index builds in one run. Deliberately small:
 * the first run after enablement is the only one that finds a large backlog,
 * and converging it over a week of nights costs nothing, while converging it
 * in one pass would put 4 × N concurrent HNSW builds on one SurrealDB.
 */
const DEFAULT_MAX_BUILDS_PER_RUN = 5;
/**
 * Pause after a tenant that actually emitted DDL, before the next one.
 * Not applied to tenants that needed nothing, so a converged roster walks
 * at full speed. Deliberately a constant and not a knob: the per-run build
 * cap is the blast-radius control, and this only stops five DEFINEs landing
 * in the same millisecond — one more environment variable would be one more
 * thing to get wrong for no operational reach.
 */
const STAGGER_MS = 250;

const EMPTY_RUN: HnswProvisionRunResult = {
  tenants: [],
  budgetExhausted: false,
  skippedForBudget: 0,
  skippedForCap: 0,
  dryRun: false,
};

@Injectable()
export class HnswProvisionService implements OnModuleInit {
  private readonly logger = new Logger(HnswProvisionService.name);
  /** Fallback reentrancy guard when JobsModule is not wired. */
  private readonly local = new InFlightGuard();
  /** Tenants noted by the schema-ready hook and not yet drained. */
  private readonly pending = new Set<string>();
  /** Tenants this process has already provisioned — the hook fires once. */
  private readonly seen = new Set<string>();
  private draining = false;

  // The roster fan-out shape: two collaborators plus three @Optional
  // platform services (the orphan-blob-GC and scene-maintenance precedent).
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly hnsw: HnswMaintenanceService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly registry?: TenantRegistryService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  /** Master gate. Off ⇒ no hook, no cron, no lease, no registry write. */
  /**
   * Provisioning follows SEARCH_HNSW_ENABLED: a deployment that rides the
   * KNN legs wants every tenant indexed, and one that does not has nothing
   * to provision. HNSW_PROVISION_ENABLED, when set explicitly, overrides
   * in either direction (e.g. build ahead of flipping the search flag).
   */
  static enabled(): boolean {
    const explicit = process.env.HNSW_PROVISION_ENABLED;
    if (explicit !== undefined && explicit !== '') return envFlagEnabled(explicit);
    return envFlagEnabled(process.env.SEARCH_HNSW_ENABLED);
  }

  private static timeBudgetMs(): number {
    return HnswProvisionService.intEnv('HNSW_PROVISION_TIME_BUDGET_MS', DEFAULT_TIME_BUDGET_MS);
  }

  private static maxBuildsPerRun(): number {
    return HnswProvisionService.intEnv(
      'HNSW_PROVISION_MAX_BUILDS_PER_RUN',
      DEFAULT_MAX_BUILDS_PER_RUN,
    );
  }

  /** Read per call so every knob stays runtime-mutable; invalid → default. */
  private static intEnv(key: string, fallback: number): number {
    const raw = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  }

  /**
   * Take the provisioning hook. Registered unconditionally — the callback
   * re-checks the master flag at call time, so the knob stays runtime-mutable
   * and a flag flip does not need a restart to take effect.
   */
  onModuleInit(): void {
    this.surreal.onTenantSchemaReady((companyId) => this.noteTenant(companyId));
  }

  /**
   * The hook body. Synchronous, allocation-only, never throws: it runs
   * inside SurrealService's global schema-apply queue, on the first request
   * for this tenant, with every other tenant's first request behind it.
   */
  noteTenant(companyId: string): void {
    if (!HnswProvisionService.enabled()) return;
    if (this.seen.has(companyId) || this.pending.has(companyId)) return;
    this.pending.add(companyId);
    void this.drain();
  }

  /**
   * Drain the pending set one tenant at a time. Concurrency is 1 by
   * construction — a second call while a drain is running returns
   * immediately and the running drain picks up whatever was added.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const companyId of this.pending) {
        this.pending.delete(companyId);
        this.seen.add(companyId);
        if (!HnswProvisionService.enabled()) continue;
        const result = await this.provisionTenant(companyId, {});
        if (result.created.length > 0) await sleep(STAGGER_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Nightly reconciliation — 05:10 UTC. The 03:00 hour is fully allocated
   * (recompose :05, compaction :17, memory quality :35, outcome prune :41,
   * calibration :42/:51, candidate sweeper :45, strategy distill :52), 04:00
   * is dreams, 04:20 scene maintenance, 04:35 orphan-blob GC. 05:10 is the
   * first clear slot after all of them, and clear of the hourly registry
   * mirror at :26. Ordering matters beyond tidiness: compaction and the
   * candidate sweeper both DELETE rows, so running after them means the
   * builds this pass starts index a settled corpus rather than one that is
   * about to shed a chunk of itself.
   *
   * Both gates are checked BEFORE the lease so a disabled sweep never
   * touches the lease table.
   */
  @Cron('10 5 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<HnswProvisionRunResult> {
    // One gate. The nightly walk used to have a second one
    // (HNSW_PROVISION_SCHEDULED); the time budget and the per-run build cap
    // already bound what a sweep may do, and a deployment that wants no
    // sweep at all wants no provisioning at all.
    if (!HnswProvisionService.enabled()) return EMPTY_RUN;
    const run = this.guard
      ? await this.guard.run(LOCK_KEY, () => this.reconcileAll(), LEASE_TTL_SECONDS)
      : await this.local.run(LOCK_KEY, () => this.reconcileAll());
    if (run === null) {
      // "Someone else has it" — another pod holds the lease, or last
      // night's pass is still walking. Skipping is the correct outcome.
      this.logger.warn('hnsw provisioning sweep skipped — a previous run is still in flight');
      return EMPTY_RUN;
    }
    return run;
  }

  /**
   * Walk the roster and bring it to the desired state. Safe to re-run: a
   * ready tenant costs two INFO probes per index and emits no DDL, and a
   * tenant whose build is still in flight is left alone rather than
   * restarted (#507 measured that a building index serves the same unranked
   * rows a missing one does — so "still building" is a state to WAIT on, not
   * to fix).
   *
   * Public and lease-free so the admin route and tests invoke the same body;
   * the master flag is re-checked in provisionTenant, so an unguarded call
   * cannot write past a disabled surface.
   */
  async reconcileAll(opts: HnswProvisionOptions = {}): Promise<HnswProvisionRunResult> {
    const deadline = Date.now() + HnswProvisionService.timeBudgetMs();
    const maxBuilds = HnswProvisionService.maxBuildsPerRun();
    const result: HnswProvisionRunResult = {
      tenants: [],
      budgetExhausted: false,
      skippedForBudget: 0,
      skippedForCap: 0,
      dryRun: opts.dryRun === true,
    };
    let builds = 0;
    for (const companyId of opts.tenants ?? this.roster()) {
      if (Date.now() >= deadline) {
        // Nothing is lost — an un-indexed tenant is rediscovered by the
        // next walk. Count what we did not start rather than drop it.
        result.budgetExhausted = true;
        result.skippedForBudget += 1;
        this.metrics?.countHnswProvision('skipped_budget');
        continue;
      }
      // At the cap we still PROBE (so the roster stays honest about this
      // tenant) but suppress the DDL — which is exactly a dry run.
      const capped = builds >= maxBuilds;
      // The sweep's own first touch of a tenant fires the schema-ready hook;
      // marking it seen first keeps the hook from provisioning it a second
      // time in parallel with this pass.
      this.seen.add(companyId);
      const tenant = await this.provisionTenant(companyId, {
        dryRun: opts.dryRun === true || capped,
      });
      if (capped && !tenant.ready) result.skippedForCap += 1;
      result.tenants.push(tenant);
      if (tenant.created.length > 0) {
        builds += 1;
        await sleep(STAGGER_MS);
      }
    }
    const notReady = result.tenants.filter((t) => !t.ready).length;
    this.logger.log(
      `hnsw provisioning sweep: ${result.tenants.length} tenant(s), ${notReady} not ready, ` +
        `${result.tenants.filter((t) => t.created.length > 0).length} provisioned` +
        `${result.dryRun ? ' (dry run)' : ''}` +
        `${result.skippedForCap > 0 ? `, ${result.skippedForCap} held back by the build cap` : ''}` +
        `${result.budgetExhausted ? `, ${result.skippedForBudget} skipped for budget` : ''}`,
    );
    // Only a walk that discovered its OWN roster may write the gauge. An
    // admin call is always scoped (the controller passes the caller's
    // tenant scope), and letting a one-tenant reconcile rewrite a
    // roster-wide series would turn "one tenant is ready" into "the fleet
    // is ready" until the next nightly pass corrected it.
    if (opts.tenants === undefined) this.publishGauge(result.tenants);
    return result;
  }

  /**
   * Bring ONE tenant to the desired state and record what was observed.
   * Never throws: a tenant that fails is reported with its `error` and the
   * roster walk continues (the dreams fan-out rule).
   */
  async provisionTenant(
    companyId: string,
    opts: HnswProvisionOptions,
  ): Promise<HnswProvisionTenantResult> {
    if (!HnswProvisionService.enabled()) {
      return { companyId, state: 'unknown', created: [], ready: false };
    }
    try {
      // 'status' is the probe-only action — it emits no DDL at all, which
      // is what makes dryRun a genuine read rather than a promise.
      const applied = await this.hnsw.apply(companyId, opts.dryRun === true ? 'status' : 'ensure');
      const state = foldState(applied);
      await this.record(companyId, applied, state);
      this.metrics?.countHnswProvision(
        opts.dryRun === true ? 'dry_run' : applied.created.length > 0 ? 'created' : state,
      );
      return { companyId, state, created: applied.created, ready: applied.ready };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.warn(`hnsw provisioning failed for ${companyId}: ${error}`);
      this.metrics?.countHnswProvision('failed');
      return { companyId, state: 'unknown', created: [], ready: false, error };
    }
  }

  /**
   * The roster read an operator (or an alert) uses to answer "which tenants
   * have a ready index". Registry only — no tenant database is opened and no
   * DDL is emitted, so it is safe to call at any cadence.
   */
  /**
   * Tenants the sweep walks: the registry's ACTIVE roster when it has one
   * (suspended tenants and dormant static keys are not provisioned, and a
   * walk over every known key would CREATE a database for each), else the
   * static key roster of a registry-less deployment.
   */
  private roster(): readonly string[] {
    const active = this.registry?.activeCompanyIds() ?? [];
    return active.length > 0 ? active : this.apiKeys.knownCompanyIds();
  }

  async rosterState(): Promise<TenantIndexStateRow[]> {
    return (await this.registry?.listIndexState()) ?? [];
  }

  private async record(
    companyId: string,
    applied: HnswMaintenanceResult,
    state: HnswProvisionState,
  ): Promise<void> {
    await this.registry?.recordIndexState(companyId, {
      state,
      detail: applied.builds.map((b) => `${b.index}=${b.state}`).join(','),
      embeddingSpace: applied.space,
    });
  }

  /** Publish the roster fold as a gauge, one series per state. */
  private publishGauge(tenants: readonly HnswProvisionTenantResult[]): void {
    if (!this.metrics) return;
    const counts = new Map<HnswProvisionState, number>();
    for (const t of tenants) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
    for (const state of [
      'ready',
      'building',
      'partial',
      'absent',
      'mismatch',
      'unknown',
    ] as const) {
      this.metrics.setHnswIndexTenants(state, counts.get(state) ?? 0);
    }
  }
}

/**
 * Fold four per-index states into the one word the roster carries.
 *
 * `mismatch` outranks everything: an index at a foreign width is worse than
 * a missing one (it also rejects writes), and no automatic action fixes it.
 * `partial` exists because a concurrent build finishes per index, and
 * because the four indexes serve different legs (entity resolution and the
 * dedup seed both ride fact_embedding_hnsw; the segment index serves the
 * coverage-scan lane), so one missing index degrades one lane, not all.
 */
function foldState(r: HnswMaintenanceResult): HnswProvisionState {
  if (r.mismatched.length > 0) return 'mismatch';
  if (r.builds.some((b) => b.state === 'unknown')) return 'unknown';
  if (r.builds.every((b) => b.state === 'ready')) return 'ready';
  if (r.builds.every((b) => b.state === 'absent')) return 'absent';
  if (r.builds.some((b) => b.state === 'building')) return 'building';
  return 'partial';
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
