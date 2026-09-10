import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant, resolvePlatformTenantScope } from '../auth/tenant-scope';
import {
  HnswMaintenanceService,
  HnswMaintenanceResult,
  MAX_BUILD_WAIT_MS,
  type HnswMaintenanceAction,
} from './hnsw-maintenance.service';
import { HnswProvisionService, type HnswProvisionRunResult } from './hnsw-provision.service';
import type { TenantIndexStateRow } from '../auth/tenant-registry.service';

const ACTIONS: readonly HnswMaintenanceAction[] = ['create', 'drop', 'status', 'ensure'];

/**
 * Synchronous by design (unlike the 202-job maintenance triggers): the
 * operator flipping SEARCH_HNSW_ENABLED needs to know whether the tenant's
 * indexes are usable before touching the flag.
 *
 * "Either applies or throws" was the old contract and it was never true of
 * the outcome that matters. Every build is CONCURRENTLY: the DDL returns in
 * ~20 ms and the build continues in the background; an index that exists
 * but is still `indexing` answers a KNN query with the same unranked,
 * null-distance rows a MISSING index does. So the response reports the
 * per-index build state and a single `ready` boolean, and `action:'status'`
 * re-reads it without emitting any DDL. Do not flip SEARCH_HNSW_ENABLED for
 * a tenant while `ready` is false.
 *
 * `waitMs` (create only) is how long THIS request holds for the builds
 * before answering with whatever progress it reached — a per-call choice,
 * so it lives in the request body rather than in deployment configuration.
 * Default 60 s, 0 answers with the first probe, at most MAX_BUILD_WAIT_MS;
 * past that, poll `status`.
 *
 * The three actions, and which one an automation may call:
 *   * `create` — DESTRUCTIVE. REMOVEs all four indexes and defines them
 *     again at the embedder's width. The repair for a width swap; never
 *     something a schedule should run, because it leaves a large tenant
 *     index-less for the length of the rebuild.
 *   * `ensure` — IDEMPOTENT. Defines only the indexes that are absent,
 *     always CONCURRENTLY, never waits. This is what provisioning and
 *     reconciliation call, and it is safe on every pass.
 *   * `status` — read-only.
 * All three now report `mismatched`: indexes that exist at a DIMENSION
 * other than the embedder's. That state is `ready` to the engine and
 * useless in fact (it rejects every write), so it can never read as ready
 * here.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminHnswController {
  constructor(
    private readonly hnsw: HnswMaintenanceService,
    private readonly provision: HnswProvisionService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/hnsw')
  @RequireScopes('brain:admin')
  async apply(
    @Req() req: AuthenticatedRequest,
    @Body() body: { action?: HnswMaintenanceAction; tenant?: string; waitMs?: unknown } = {},
  ): Promise<HnswMaintenanceResult> {
    const action = body.action ?? 'create';
    if (!ACTIONS.includes(action)) {
      throw new BadRequestException(`action must be one of ${ACTIONS.join(', ')}`);
    }
    if (
      body.waitMs !== undefined &&
      (typeof body.waitMs !== 'number' ||
        !Number.isInteger(body.waitMs) ||
        body.waitMs < 0 ||
        body.waitMs > MAX_BUILD_WAIT_MS)
    ) {
      throw new BadRequestException(
        `waitMs must be an integer between 0 and ${MAX_BUILD_WAIT_MS} (milliseconds)`,
      );
    }
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.hnsw.apply(
      tenant,
      action,
      body.waitMs === undefined ? {} : { waitMs: body.waitMs },
    );
  }

  /**
   * The roster read: which tenants have a ready index, answered from
   * `tenant_registry` alone. No tenant database is opened and no DDL is
   * emitted, which is the whole point — before this, the only way to know
   * was to probe every tenant one at a time, so nobody knew.
   *
   * A row whose `observedAt` is absent has never been looked at; a row
   * whose `observedAt` is old is an observation, not a promise. Scoped like
   * every other cross-tenant admin read: a plain `brain:admin` sees its own
   * tenant, a platform operator (scope + gate) sees the roster.
   */
  @Get('maintenance/hnsw/roster')
  @RequireScopes('brain:admin')
  async roster(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ tenants: TenantIndexStateRow[]; notReady: number }> {
    const scope = new Set(
      resolvePlatformTenantScope(req, undefined, {
        knownTenants: () => this.apiKeys.knownCompanyIds(),
        fanOutTenants: () => this.apiKeys.fanOutRoster(),
      }),
    );
    const tenants = (await this.provision.rosterState()).filter((r) => scope.has(r.companyId));
    return { tenants, notReady: tenants.filter((r) => r.state !== 'ready').length };
  }

  /**
   * Run reconciliation NOW rather than waiting for 05:10 UTC — the operator
   * action the nightly sweep exists to make unnecessary. `dryRun` probes and
   * records without emitting any DDL, which is the right first call on a
   * deployment that has never provisioned anything.
   *
   * Cross-tenant, so it is gated by the platform scope: a plain
   * `brain:admin` reconciles its own tenant and nothing else.
   */
  @Post('maintenance/hnsw/reconcile')
  @RequireScopes('brain:admin')
  async reconcile(
    @Req() req: AuthenticatedRequest,
    @Body() body: { dryRun?: boolean; tenant?: string } = {},
  ): Promise<HnswProvisionRunResult> {
    const tenants = resolvePlatformTenantScope(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
      fanOutTenants: () => this.apiKeys.fanOutRoster(),
    });
    return this.provision.reconcileAll({ dryRun: body.dryRun === true, tenants });
  }
}
