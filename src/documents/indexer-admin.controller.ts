import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import type {
  IndexerOverviewListResponse,
  IndexerRunListResponse,
} from '../contracts/indexer/indexer-operator.schema';
import { IndexerOperatorService } from './indexer-operator.service';
import { indexerOperatorViewEnabled } from './documents-gate';

/**
 * The operator view over a tenant's indexers — the gap this closes: an
 * indexer's identity IS its pack, and `indexer_run` has recorded run
 * health since migration 0049, but the only HTTP surface over that
 * ledger was GET /v1/indexer/work — the EXTERNAL poller's own work
 * queue, not an operator's view. Nothing listed a tenant's installed
 * indexers or told an operator whether they were running, failing, or
 * (for external packs) being polled at all.
 *
 *  - GET /v1/admin/indexers            — one row per declared indexer:
 *    mode, pack id + installed version, last run, and window-bounded
 *    run/candidate tallies (plus publisher liveness for external mode).
 *  - GET /v1/admin/indexers/:packId/runs — recent runs of one indexer.
 *
 * READ-ONLY: no mutation verb lives here. Retrying, releasing, or
 * re-indexing stays with the surfaces that already own those decisions.
 *
 * Dark behind INDEXER_OPERATOR_VIEW_ENABLED (default off ⇒ 404 — the
 * route does not exist for a tenant that has not opted in), read at call
 * time so a flip is runtime-mutable. Scope `brain:admin` like every
 * sibling under /v1/admin; the tenant seam is resolvePlatformTenant, so
 * a plain admin can only ever read its OWN tenant's ledger.
 */
@Controller('v1/admin/indexers')
@UseGuards(ApiKeyGuard)
export class IndexerAdminController {
  constructor(
    private readonly operator: IndexerOperatorService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: IndexerViewQuery = {},
  ): Promise<IndexerOverviewListResponse> {
    if (!indexerOperatorViewEnabled()) throw new NotFoundException();
    return this.operator.listIndexers({
      companyId: this.resolveTenant(req, q.tenant),
      days: parseCount(q.days),
      runCap: parseCount(q.runCap),
    });
  }

  @Get(':packId/runs')
  @RequireScopes('brain:admin')
  async runs(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
    @Query() q: IndexerViewQuery = {},
  ): Promise<IndexerRunListResponse> {
    if (!indexerOperatorViewEnabled()) throw new NotFoundException();
    return this.operator.listRuns({
      companyId: this.resolveTenant(req, q.tenant),
      packId,
      days: parseCount(q.days),
      limit: parseCount(q.limit),
    });
  }

  /** ONE tenant-resolution seam for both reads (the R3 admin idiom). */
  private resolveTenant(req: AuthenticatedRequest, requested: string | undefined): string {
    return resolvePlatformTenant(req, requested, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
  }
}

/** Query string of both reads — every field optional, every value clamped. */
interface IndexerViewQuery {
  /** Target tenant; only a platform operator may name a foreign one. */
  tenant?: string;
  /** Window width in days (default 7, max 90). */
  days?: string;
  /** Runs read per indexer on the list route (default 50, max 200). */
  runCap?: string;
  /** Runs returned by the detail route (default 50, max 200). */
  limit?: string;
}

/** Query ints are advisory — the service clamps; garbage reads as absent. */
function parseCount(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
