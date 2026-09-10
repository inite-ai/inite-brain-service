import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { DistributedLeaseGuard } from '../common/distributed-lease.guard';
import { InFlightGuard } from '../common/in-flight-guard';
import {
  clearDirtyConversations,
  selectDirtyConversations,
  type DirtyConversationRow,
} from '../common/scene-dirty';
import {
  sceneBeliefPromotionEnabled,
  sceneMaintenanceMaxConversations,
  sceneMaintenanceTimeBudgetMs,
  sceneScheduledMaintenanceEnabled,
  sceneSegmentationEnabled,
} from '../common/scene-flags';
import { SceneComposerService } from './scene-composer.service';
import { BeliefPromotionService } from './belief-promotion.service';
import {
  POST_PASS_KEY,
  emptyBatchOutcome,
  errorMessage,
  failedBatchOutcome,
  foldBatchOutcome,
  foldNestedOutcomes,
  type BatchOutcome,
} from '../common/batch-outcome';

/** One tenant's slice of a nightly run. */
export interface SceneMaintenanceTenantResult {
  companyId: string;
  /** Dirty conversations the budget admitted (0 ⇒ nothing had moved). */
  dirty: number;
  conversations: number;
  scenes: number;
  /** Scenes the LLM enrichment leg re-wrote — the run's paid work. */
  enriched: number;
  /** semantic_belief upserts (created + revised + corroborated). */
  beliefs: number;
  /** Marks retired; < dirty when turns landed DURING the pass. */
  cleared: number;
  durationSeconds: number;
  error?: string;
  /**
   * The composer's outcome plus belief promotion as a post-pass; a tenant
   * whose pass threw carries `failedBatchOutcome` (key `*`).
   */
  outcome: BatchOutcome;
}

/** Whole-roster summary — the cron's return value and the log line. */
export interface SceneMaintenanceRunResult {
  tenants: SceneMaintenanceTenantResult[];
  /** True when the wall-clock budget stopped the roster walk early. */
  budgetExhausted: boolean;
  /** Tenants never started because the budget ran out. */
  skippedForBudget: number;
  /** Roster fold: units are tenants (`failed[].key` is a companyId). */
  outcome: BatchOutcome;
}

/** Lock key for both the local and the distributed guard. */
const LOCK_KEY = 'scene_maintenance_all';

/**
 * Lease TTL for the distributed guard. Matches the DEFAULT whole-run
 * wall-clock budget (30 min) rather than the guard's own 5-minute default:
 * a lease shorter than the body it protects expires mid-run and lets a
 * second pod start a parallel pass over the same dirty rows — two composers
 * swapping the same (conversation × segmenterVersion) id-space, plus double
 * enrichment spend. Deliberately NOT derived from
 * SCENES_MAINTENANCE_TIME_BUDGET_MS: an operator who raises that knob past
 * this TTL should see the overlap warning and raise the deployment's pod
 * count expectations consciously, not have a lease silently follow a knob.
 */
const LEASE_TTL_SECONDS = 30 * 60;

const EMPTY_RUN: SceneMaintenanceRunResult = {
  tenants: [],
  budgetExhausted: false,
  skippedForBudget: 0,
  outcome: emptyBatchOutcome(),
};

/**
 * SceneMaintenanceService — the missing SCHEDULER for the scene plane.
 *
 * THE HOLE THIS CLOSES. Every other nightly derivation owns a cron:
 * recompose 03:05, compaction 03:17, memory quality 03:35, outcome prune
 * 03:41, calibration refit 03:42/03:51, candidate sweeper 03:45, strategy
 * distill 03:52, dreams 04:00. Scenes owned none. `SceneComposerService.run`
 * had exactly one caller — the admin controller — so with all eight SCENES_*
 * flags on in production, scenes (and therefore the BELIEFS promoted out of
 * them, which the serving lane reads) existed only for conversations a human
 * had curled. This service runs the chain on a schedule, per tenant:
 *
 *     dirty page → compose → [enrich → backlink → evidence links, inside the
 *     composer's post-swap chain] → belief promotion → clear the marks
 *
 * CRON SLOT — 04:20 UTC. Every :0x–:5x minute of the 03:00 hour is spoken
 * for (see the list above), and 04:00 is dreams. 04:20 is the first free
 * slot AFTER dreams has had its full worker lease (dreams enqueues per-tenant
 * jobs with ttlSeconds 1200 = 20 min), which matters for more than tidiness:
 * dreams and scene enrichment are the two LLM-heavy nightly passes, and
 * overlapping them would have them bid against each other for the same
 * rate limit on the same key. It is also clear of the hourly registry mirror
 * (:26). The pass reads a substrate that compaction and dreams have already
 * settled — the same reasoning that put dreams 43 minutes after compaction.
 *
 * BUDGETS ARE NOT OPTIONAL. Composing a conversation costs one embedding
 * batch when SCENES_TOPIC_BOUNDARY is on, and the post-swap enrichment
 * spends ONE structured LLM call per NEW scene. An unbounded roster walk
 * therefore has an unbounded model bill and an unbounded runtime, and one
 * large tenant could consume the entire night. Two fences:
 *   * SCENES_MAINTENANCE_MAX_CONVERSATIONS (default 200) caps the dirty
 *     page per tenant per run, oldest mark first, so a backlog drains in
 *     arrival order across nights instead of starving old conversations;
 *   * SCENES_MAINTENANCE_TIME_BUDGET_MS (default 30 min) stops the roster
 *     from STARTING new tenants once elapsed. It never aborts a tenant
 *     mid-flight: interrupting a compose between the paid step and the swap
 *     is exactly the failure mode the composer's ordering exists to avoid.
 * Nothing is lost when a budget bites — unconsumed marks are still there
 * tomorrow, and the tenants that were skipped are counted, not forgotten.
 *
 * ISOLATION. One tenant's failure is caught, counted and logged; the roster
 * continues (the dreams fan-out rule). One tenant's marks are cleared only
 * for conversations whose swap did NOT report a skip, so a partial failure
 * re-composes exactly the failed conversations next night.
 *
 * OVERLAP. Guarded by the distributed lease (one pod runs it, and never
 * concurrently with itself) with a local InFlightGuard as the fallback when
 * JobsModule is not wired — a 30-minute pass and a daily cron leave plenty
 * of room for a slow night to still be running at the next firing.
 *
 * Default off (SCENES_SCHEDULED_MAINTENANCE): the cron returns before a
 * single query and no mark is ever written — byte-identical prod.
 */
@Injectable()
export class SceneMaintenanceService {
  private readonly logger = new Logger(SceneMaintenanceService.name);
  /**
   * Fallback reentrancy guard for the no-DI paths (positional unit tests,
   * a deployment without JobsModule). DistributedLeaseGuard carries its own
   * local guard, so exactly one of the two is ever consulted.
   */
  private readonly local = new InFlightGuard();

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly composer: SceneComposerService,
    private readonly beliefs: BeliefPromotionService,
    // @Optional throughout for the positional unit tests (no DI). In
    // production MetricsModule and JobsModule are both @Global.
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  /**
   * Cron entry — daily at 04:20 UTC (slot rationale in the class docblock).
   *
   * Returns the run summary so a caller (tests, a future admin trigger) can
   * see what happened; the @nestjs/schedule loop ignores it.
   */
  @Cron('20 4 * * *', { timeZone: 'UTC' })
  async runNightly(): Promise<SceneMaintenanceRunResult> {
    // Double gate: the master flag decides whether scenes exist at all, the
    // maintenance flag whether they are built on a schedule. Read at call
    // time so both are runtime-mutable, and checked BEFORE the guard so a
    // disabled pass never even touches the lease table.
    if (!sceneSegmentationEnabled() || !sceneScheduledMaintenanceEnabled()) return EMPTY_RUN;
    const run = this.guard
      ? await this.guard.run(LOCK_KEY, () => this.runAll(), LEASE_TTL_SECONDS)
      : await this.local.run(LOCK_KEY, () => this.runAll());
    if (run === null) {
      // The guard's null is "someone else has it" — either the previous
      // night's pass is still going on this pod or another pod holds the
      // lease. Never an error: skipping is the correct outcome.
      this.logger.warn('scene maintenance skipped — a previous run is still in flight');
      return EMPTY_RUN;
    }
    return run;
  }

  /**
   * Walk the tenant roster under the wall-clock budget. Public so tests and
   * future manual triggers can invoke the body without the guard; the flag
   * check lives in the cron entry, and the composer/promotion services both
   * re-check their own flags, so an unguarded call cannot write past a
   * disabled surface.
   */
  async runAll(): Promise<SceneMaintenanceRunResult> {
    const startedAt = Date.now();
    const deadline = startedAt + sceneMaintenanceTimeBudgetMs();
    const maxConversations = sceneMaintenanceMaxConversations();
    const roster = this.apiKeys.knownCompanyIds();
    const result: SceneMaintenanceRunResult = {
      tenants: [],
      budgetExhausted: false,
      skippedForBudget: 0,
      outcome: emptyBatchOutcome(),
    };
    for (const companyId of roster) {
      if (Date.now() >= deadline) {
        // Budget bite: count what we did not start rather than silently
        // dropping it. The marks survive; tomorrow's run picks them up.
        result.budgetExhausted = true;
        result.skippedForBudget += 1;
        this.metrics?.countSceneMaintenance('skipped_budget');
        continue;
      }
      const tenantStart = Date.now();
      try {
        const tenant = await this.runTenant(companyId, maxConversations);
        result.tenants.push(tenant);
      } catch (e) {
        // Per-tenant isolation (the dreams fan-out rule): a Surreal hiccup
        // or a composer throw on tenant N must not cost tenant N+1 its
        // night. The tenant keeps its marks and retries tomorrow.
        const message = (e as Error).message;
        this.logger.warn(`scene maintenance failed for ${companyId}: ${message}`);
        this.metrics?.countSceneMaintenance('failed');
        this.metrics?.observeSceneMaintenanceDuration((Date.now() - tenantStart) / 1000);
        result.tenants.push({
          companyId,
          dirty: 0,
          conversations: 0,
          scenes: 0,
          enriched: 0,
          beliefs: 0,
          cleared: 0,
          durationSeconds: (Date.now() - tenantStart) / 1000,
          error: message,
          outcome: failedBatchOutcome(message),
        });
      }
    }
    result.outcome = foldNestedOutcomes(
      result.tenants.map((t) => ({ key: t.companyId, outcome: t.outcome })),
    );
    const scenes = result.tenants.reduce((n, t) => n + t.scenes, 0);
    this.logger.log(
      `scene maintenance: ${result.tenants.length}/${roster.length} tenant(s), ` +
        `${scenes} scene(s), ${result.skippedForBudget} skipped for budget, ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    return result;
  }

  /**
   * One tenant: read the dirty page, compose exactly it, promote beliefs,
   * clear the marks it consumed.
   *
   * `readAt` is captured BEFORE the dirty read on purpose — it is the race
   * fence handed to `clearDirtyConversations`. A turn arriving during the
   * (long, paid) compose bumps its mark past this instant, the mark survives
   * the clear, and that conversation recomposes tomorrow. Never the reverse.
   */
  async runTenant(
    companyId: string,
    maxConversations: number,
  ): Promise<SceneMaintenanceTenantResult> {
    const startedAt = Date.now();
    const readAt = new Date();
    const dirty = await this.surreal.withCompany(companyId, (db) =>
      selectDirtyConversations(db, maxConversations),
    );
    if (dirty.length === 0) {
      // The steady state on a quiet tenant, and the series that proves the
      // trigger works end to end: marks are being written AND cleared.
      this.metrics?.countSceneMaintenance('skipped_no_dirty');
      this.metrics?.observeSceneMaintenanceDuration((Date.now() - startedAt) / 1000);
      return {
        companyId,
        dirty: 0,
        conversations: 0,
        scenes: 0,
        enriched: 0,
        beliefs: 0,
        cleared: 0,
        durationSeconds: (Date.now() - startedAt) / 1000,
        outcome: emptyBatchOutcome(),
      };
    }

    // ONE composer call for the whole page — the composer's conversationIds
    // path skips its O(all turns) enumeration entirely, and the post-swap
    // enrich/backlink/evidence-link chain runs once instead of per
    // conversation. Calling it per conversation would re-run that chain N
    // times for no extra output.
    const composed = await this.composer.run(companyId, {
      conversationIds: dirty.map((d) => d.conversationId),
    });

    // Beliefs are the reason any of this is user-visible (the serving lane
    // reads semantic_belief), so the promotion leg runs every pass — but it
    // degrades, never fails: the scene swap has already landed and must not
    // be retracted by a failing optional pass. Same doctrine as the
    // composer's own post-swap chain — and, like there, the failure lands
    // in the outcome's `degradedBy` rather than only in a log line.
    let beliefs = 0;
    const degradedBy = [...composed.outcome.degradedBy];
    if (sceneBeliefPromotionEnabled()) {
      try {
        const promoted = await this.beliefs.run(companyId, {});
        beliefs = promoted.beliefsCreated + promoted.beliefsRevised + promoted.beliefsCorroborated;
      } catch (e) {
        this.logger.warn(`belief promotion failed for ${companyId}: ${errorMessage(e)}`);
        degradedBy.push({ key: `${POST_PASS_KEY}belief-promotion`, error: errorMessage(e) });
      }
    }
    const outcome = foldBatchOutcome({
      total: composed.outcome.total,
      succeeded: composed.outcome.succeeded,
      failed: composed.outcome.failed,
      degradedBy,
    });

    const cleared = await this.clearConsumed({
      companyId,
      dirty,
      skipped: composed.skipped,
      readAt,
    });
    const durationSeconds = (Date.now() - startedAt) / 1000;
    const enriched = composed.enriched ?? 0;
    this.metrics?.countSceneMaintenance('ok');
    this.metrics?.observeSceneMaintenanceDuration(durationSeconds);
    this.metrics?.countSceneMaintenanceEmitted('conversation', composed.conversations);
    this.metrics?.countSceneMaintenanceEmitted('scene', composed.scenes);
    this.metrics?.countSceneMaintenanceEmitted('enriched', enriched);
    this.metrics?.countSceneMaintenanceEmitted('belief', beliefs);
    this.metrics?.countSceneMaintenanceEmitted('dirty_cleared', cleared);
    this.logger.log(
      `scene maintenance ${companyId}: ${dirty.length} dirty, ` +
        `${composed.conversations} composed, ${composed.scenes} scene(s), ` +
        `${enriched} enriched, ${beliefs} belief(s), ${cleared} mark(s) cleared, ` +
        `${durationSeconds.toFixed(1)}s`,
    );
    return {
      companyId,
      dirty: dirty.length,
      conversations: composed.conversations,
      scenes: composed.scenes,
      enriched,
      beliefs,
      cleared,
      durationSeconds,
      outcome,
    };
  }

  /**
   * Retire the marks for conversations whose swap did NOT report a skip. A
   * conversation the composer skipped keeps its mark and is retried on the
   * next pass — the composer's per-conversation try/catch already isolates
   * it, so the ONLY thing that would make the failure permanent is clearing
   * its mark here.
   */
  private async clearConsumed(args: {
    companyId: string;
    dirty: DirtyConversationRow[];
    skipped: Array<{ conversationId: string }>;
    readAt: Date;
  }): Promise<number> {
    const { companyId, dirty, skipped, readAt } = args;
    const failed = new Set(skipped.map((s) => s.conversationId));
    const ids = dirty.filter((d) => !failed.has(d.conversationId)).map((d) => d.id);
    if (ids.length === 0) return 0;
    return this.surreal.withCompany(companyId, (db) => clearDirtyConversations(db, ids, readAt));
  }
}
