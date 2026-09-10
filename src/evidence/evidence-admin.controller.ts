import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import {
  evidenceSubstrateEnabled,
  orphanBlobGcEnabled,
  processorBrokerEnabled,
} from '../common/evidence-flags';
import {
  EvidenceOrphanBlobGcService,
  type OrphanBlobGcTenantResult,
} from './orphan-blob-gc.service';
import {
  EvidenceProcessorBrokerService,
  type DispatchSweepResult,
} from './processor-broker.service';
import { parseBatchKeys } from '../common/batch-outcome';

/** Param belt: a pack id is a short slug, not free text. */
const PACK_ID_MAX_CHARS = 200;
/** Param belt: an asset id is a `evidence_asset:<tail>` record id. */
const ASSET_ID_MAX_CHARS = 256;
/** Retry-selector belt: the sweep's own hard bound. */
const KEYS_MAX = 1000;

interface DispatchBody {
  tenant?: string;
  packId?: string;
  assetId?: string;
  /** Retry selector: `outcome.failed[].key` of a previous sweep. */
  keys?: string[];
  limit?: number;
}

interface OrphanBlobGcBody {
  tenant?: string;
  /** Force report-only. Cannot enable deletion — only the flag can. */
  dryRun?: boolean;
  /** Lower this run's deletion cap. Never raises the configured one. */
  maxDeletions?: number;
}

/**
 * POST /v1/admin/maintenance/evidence/dispatch — the operator's handle on
 * the trusted processor broker (Brain v2.1 MM-7).
 *
 * The upload path dispatches for at most the pack a caller names, at the
 * moment bytes land. That leaves the two cases an operator actually has:
 * a pack installed AFTER assets were registered, and a processor adapter
 * added to the platform after a pack was installed. This verb sweeps the
 * existing corpus for both — bounded per call, replay-idempotent (the
 * broker's deterministic run ids + INSERT IGNORE), and per-asset
 * fault-tolerant.
 *
 * Follows the admin-scenes idiom exactly: `brain:admin`, the shared
 * resolvePlatformTenant seam (an admin key reaches only its OWN tenant
 * unless it carries `brain:platform_admin` AND the override gate is on),
 * and a bare 404 while the feature is off — the double gate, so a dark
 * broker never advertises a maintenance surface. Deliberately NOT a cron:
 * v1 ships no scheduler (processing-run.service.ts claimRun), and a sweep
 * that runs itself would need its own flag, its own claim, and its own
 * backpressure story.
 *
 * The controller now hosts a SECOND maintenance verb on the same idiom —
 * `…/evidence/orphan-blob-gc`, the delete-side hygiene sweep — with its
 * own flag and its own gate; see the method docblock for how the two
 * differ.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class EvidenceAdminController {
  constructor(
    private readonly broker: EvidenceProcessorBrokerService,
    private readonly apiKeys: ApiKeyService,
    private readonly orphanGc: EvidenceOrphanBlobGcService,
  ) {}

  @Post('maintenance/evidence/dispatch')
  @RequireScopes('brain:admin')
  async dispatch(
    @Req() req: AuthenticatedRequest,
    @Body() body: DispatchBody = {},
  ): Promise<DispatchSweepResult> {
    // Double-gate idiom: 404 here + the service's own 503 gate (off =
    // zero queries, byte-identical prod).
    if (!processorBrokerEnabled() || !evidenceSubstrateEnabled()) throw new NotFoundException();
    const packId = (body.packId ?? '').trim();
    if (packId === '' || packId.length > PACK_ID_MAX_CHARS) {
      throw new BadRequestException(
        `packId is required and must be at most ${PACK_ID_MAX_CHARS} characters`,
      );
    }
    const assetId = this.assetId(body.assetId);
    const assetIds = parseBatchKeys(body.keys, {
      maxKeys: KEYS_MAX,
      maxLength: ASSET_ID_MAX_CHARS,
      accept: (key) => key.startsWith('evidence_asset:'),
    });
    if (assetIds !== undefined && assetId !== undefined) {
      throw new BadRequestException('pass either assetId or keys, not both');
    }
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.broker.dispatchSweep(tenant, {
      packId,
      assetId,
      assetIds,
      limit: body.limit,
    });
  }

  /**
   * POST /v1/admin/maintenance/evidence/orphan-blob-gc — the operator's
   * handle on the orphan-blob sweep (see orphan-blob-gc.service.ts for
   * what an orphan is and why the pass is safe to run live).
   *
   * The REQUIRED trigger, and the one an operator reaches for first: the
   * nightly cron is optional and off by default, so this route is how a
   * dry run gets looked at before deletion is ever enabled. Same
   * admin-scenes idiom as the dispatch verb above — `brain:admin`, the
   * shared resolvePlatformTenant seam (an admin key reaches only its OWN
   * tenant unless it carries `brain:platform_admin` AND the override gate
   * is on), and a bare 404 while the feature is off.
   *
   * Gated on EVIDENCE_ORPHAN_BLOB_GC ALONE — deliberately NOT also on
   * EVIDENCE_SUBSTRATE_ENABLED, unlike the dispatch verb. Dispatch is a
   * write-side surface and must not run while the writers are dark; this
   * is a delete-side hygiene pass, and bytes written while the substrate
   * was on must stay collectable after it is turned off (the
   * sweepTenantEvidence precedent).
   *
   * `dryRun: true` and a lower `maxDeletions` are the only two things the
   * body can say about safety, and both can only make the run MORE
   * conservative: whether a byte may be destroyed at all is
   * EVIDENCE_ORPHAN_BLOB_GC_DELETE's decision, never the caller's.
   */
  @Post('maintenance/evidence/orphan-blob-gc')
  @RequireScopes('brain:admin')
  async orphanBlobGc(
    @Req() req: AuthenticatedRequest,
    @Body() body: OrphanBlobGcBody = {},
  ): Promise<OrphanBlobGcTenantResult> {
    if (!orphanBlobGcEnabled()) throw new NotFoundException();
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.orphanGc.sweepTenant(tenant, {
      dryRun: body.dryRun === true,
      maxDeletions: this.maxDeletions(body.maxDeletions),
    });
  }

  /** Optional per-run tightening of the deletion cap. */
  private maxDeletions(raw: number | undefined): number | undefined {
    if (raw === undefined) return undefined;
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new BadRequestException('maxDeletions must be a positive integer');
    }
    return raw;
  }

  /** Optional single-asset target; the broker clamps the sweep bound. */
  private assetId(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const assetId = raw.trim();
    if (!assetId.startsWith('evidence_asset:') || assetId.length > ASSET_ID_MAX_CHARS) {
      throw new BadRequestException('assetId must be an evidence_asset record id');
    }
    return assetId;
  }
}
