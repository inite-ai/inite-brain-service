import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import type {
  EvidenceGrantsListResponse,
  GrantEvidenceAccessResponse,
  RevokeEvidenceGrantResponse,
} from '../contracts/evidence/grants.schema';
import { PolicyAction } from '../policy/action-registry';
import { GrantEvidenceAccessDto } from './dto/grant-evidence-access.dto';
import { EvidenceGrantService, type GrantCaller } from './evidence-grant.service';
import { EvidenceGrantsEnabledGuard } from './evidence-grants.guard';

/**
 * EvidenceGrantsController (Brain v2.1 MM-4, migration 0122) — the
 * sharing surface the grant machinery has been waiting for: who may hold
 * an observation, expressed over HTTP.
 *
 * Routes (all a bare 404 while EVIDENCE_GRANTS_API_ENABLED or
 * EVIDENCE_SUBSTRATE_ENABLED is off — the EPISODES_API_ENABLED idiom,
 * indistinguishable from absent routes):
 *   POST   /v1/evidence/{assetId}/grants   — share with a user or pack
 *   GET    /v1/evidence/{assetId}/grants   — the asset's live owners
 *   DELETE /v1/evidence/grants/{grantId}   — revoke (idempotent)
 * That 404 comes from EvidenceGrantsEnabledGuard, which Nest runs BEFORE
 * the global ValidationPipe — so while the surface is off, a malformed
 * body cannot answer 400 and advertise the route (see the guard's doc).
 *
 * Transport only. The authorization ladder (tenant fence → liveness +
 * retention → ownership → media PII) lives in EvidenceGrantService, and
 * persistence stays in the ONE write seam (EvidenceStoreService) — layer
 * purity: controllers never import src/db.
 *
 * NO EXISTENCE ORACLE, which is the whole point of the PR. 0122 held
 * this surface back because a sharing route is where a hash-probing
 * client would look for one, so:
 *   - assets are addressed by RECORD ID only. No route, body field or
 *     query parameter takes a byteHash — content identity never resolves
 *     to a row here (registerAsset's bare 409 closes the other half);
 *   - unknown asset, foreign tenant, tombstoned/quarantined/past-
 *     retention asset, non-owner, media-PII-blocked and malformed id all
 *     answer the SAME bare 404, over the same two DB round-trips;
 *   - the grantee handle is never checked for existence, so the share
 *     verb is not a user-enumeration oracle either;
 *   - the owner list reaches owners only.
 * The one thing a caller CAN learn is what they were already entitled
 * to: whether an asset they own holds a given live grant.
 *
 * Scopes and ABAC: `brain:write` + `rest.evidence.grant` to share,
 * `brain:write` + `rest.evidence.revoke` to take back, `brain:read` +
 * `rest.evidence.grants` to list. ABAC opens the VERB; the ladder still
 * decides the ASSET, so a policy can never hand out an asset the caller
 * does not hold.
 */
@Controller('v1/evidence')
@UseGuards(EvidenceGrantsEnabledGuard, ApiKeyGuard)
export class EvidenceGrantsController {
  constructor(private readonly grants: EvidenceGrantService) {}

  @Post(':assetId/grants')
  @RequireScopes('brain:write')
  @PolicyAction('rest.evidence.grant')
  async grant(
    @Req() req: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Body() body: GrantEvidenceAccessDto,
  ): Promise<GrantEvidenceAccessResponse> {
    return this.grants.grant(req.brainAuth.companyId, callerOf(req), {
      assetId,
      ownerKind: body.ownerKind,
      ownerId: body.ownerId,
      purpose: body.purpose,
    });
  }

  @Get(':assetId/grants')
  @RequireScopes('brain:read')
  @PolicyAction('rest.evidence.grants')
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<EvidenceGrantsListResponse> {
    return this.grants.list(req.brainAuth.companyId, callerOf(req), assetId);
  }

  /** Declared under a LITERAL prefix ('grants/…') so it can never be
   *  read as an asset id, and DELETE-only so it shares no pattern with
   *  the raw-read gateway's GET routes on the same controller prefix. */
  @Delete('grants/:grantId')
  @RequireScopes('brain:write')
  @PolicyAction('rest.evidence.revoke')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('grantId') grantId: string,
  ): Promise<RevokeEvidenceGrantResponse> {
    return this.grants.revoke(req.brainAuth.companyId, callerOf(req), grantId);
  }
}

/** The brainAuth slice the ladder fences on — one spreadable object so
 *  the handlers stay within the max-params discipline. */
function callerOf(req: AuthenticatedRequest): GrantCaller {
  const { scopes, userId } = req.brainAuth;
  return { scopes, userId };
}
