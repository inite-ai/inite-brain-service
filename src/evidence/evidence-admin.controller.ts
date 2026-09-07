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
import { evidenceSubstrateEnabled, processorBrokerEnabled } from '../common/evidence-flags';
import {
  EvidenceProcessorBrokerService,
  type DispatchSweepResult,
} from './processor-broker.service';

/** Param belt: a pack id is a short slug, not free text. */
const PACK_ID_MAX_CHARS = 200;
/** Param belt: an asset id is a `evidence_asset:<tail>` record id. */
const ASSET_ID_MAX_CHARS = 256;

interface DispatchBody {
  tenant?: string;
  packId?: string;
  assetId?: string;
  limit?: number;
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
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class EvidenceAdminController {
  constructor(
    private readonly broker: EvidenceProcessorBrokerService,
    private readonly apiKeys: ApiKeyService,
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
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.broker.dispatchSweep(tenant, {
      packId,
      assetId,
      limit: body.limit,
    });
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
