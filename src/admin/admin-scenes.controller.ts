import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import {
  sceneBeliefPromotionEnabled,
  sceneFactBacklinkEnabled,
  sceneLlmEnrichmentEnabled,
  sceneSegmentationEnabled,
} from '../common/scene-flags';
import { SceneComposerService, SceneRunResult } from './scene-composer.service';
import { SceneEnricherService, SceneEnrichResult } from './scene-enricher.service';
import { SceneBacklinkService, SceneBacklinkResult } from './scene-backlink.service';
import { BeliefPromotionService, BeliefPromotionResult } from './belief-promotion.service';

/** Purge param belt: DB stamps are short version slugs, not free text. */
// 128 (was 64): pack scene worlds (0110) are versioned
// `pack:<packId≤64>+<8-hex fp>` — up to 78 chars — and purge through this
// same verb. Still just an input bound on a path parameter.
const SEGMENTER_VERSION_MAX_CHARS = 128;

/**
 * Explicit triggers for the Brain v2 scene surface (shadow memory_episode
 * substrate, migration 0106):
 *
 *  - POST /scenes — the PR1 composer (LLM-free; embedding cost only when
 *    SCENES_TOPIC_BOUNDARY is on). Idempotent per (conversation ×
 *    segmenterVersion) — atomic delete-then-insert swap. When the PR2
 *    flags are on it also runs the enrichment/backlink passes after the
 *    swap.
 *  - POST /scenes/enrich — standalone re-enrichment (PR2): ONE structured
 *    LLM call per scene of the current effective segmenter version. 404
 *    unless BOTH the master flag and SCENES_LLM_ENRICHMENT are on.
 *    Idempotent (0118): scenes already at the current enrichmentVersion
 *    composite (prompt|scorer|model) are SKIPPED — a re-run with an
 *    unchanged configuration makes zero paid calls.
 *  - POST /scenes/backlink — standalone fact backlink (PR2): idempotent
 *    source.memoryEpisodeIds stamps. 404 unless BOTH the master flag and
 *    SCENES_FACT_BACKLINK are on.
 *  - POST /scenes/beliefs — belief promotion (Belief-A, migration 0120):
 *    folds ENRICHED scenes of the current effective segmenter version
 *    into semantic_belief upserts keyed by free-text (subject, field).
 *    404 unless BOTH the master flag and SCENES_BELIEF_PROMOTION are on.
 *    Replay-idempotent (deterministic revision ids + INSERT IGNORE +
 *    array::union stamps).
 *  - DELETE /scenes/versions/:segmenterVersion — purge one version's
 *    scene world (members → scenes, one transaction) and demote its
 *    projection ledger row to 'residual'. 404 when the master flag is
 *    off. Accepts fingerprinted version strings
 *    (`scene-segmenter-v1+<8hex>`, SCENES_VERSION_FINGERPRINT) — `+` is a
 *    literal character in a URL path segment — so abandoned fingerprint
 *    worlds are purged through the same verb.
 *
 * All flags are read at call time (runtime-mutable).
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminScenesController {
  // eslint-disable-next-line max-params
  constructor(
    private readonly composer: SceneComposerService,
    private readonly enricher: SceneEnricherService,
    private readonly backlinker: SceneBacklinkService,
    private readonly beliefs: BeliefPromotionService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/scenes')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; conversationId?: string } = {},
  ): Promise<SceneRunResult> {
    if (!sceneSegmentationEnabled()) throw new NotFoundException();
    const tenant = this.resolveTenant(req, body.tenant);
    return this.composer.run(
      tenant,
      body.conversationId !== undefined ? { conversationId: body.conversationId } : {},
    );
  }

  @Post('maintenance/scenes/enrich')
  @RequireScopes('brain:admin')
  async enrich(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; conversationId?: string } = {},
  ): Promise<SceneEnrichResult> {
    if (!sceneSegmentationEnabled() || !sceneLlmEnrichmentEnabled()) {
      throw new NotFoundException();
    }
    const tenant = this.resolveTenant(req, body.tenant);
    return this.enricher.enrich(
      tenant,
      body.conversationId !== undefined ? { conversationId: body.conversationId } : {},
    );
  }

  @Post('maintenance/scenes/backlink')
  @RequireScopes('brain:admin')
  async backlink(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; conversationId?: string } = {},
  ): Promise<SceneBacklinkResult> {
    if (!sceneSegmentationEnabled() || !sceneFactBacklinkEnabled()) {
      throw new NotFoundException();
    }
    const tenant = this.resolveTenant(req, body.tenant);
    return this.backlinker.run(
      tenant,
      body.conversationId !== undefined ? { conversationId: body.conversationId } : {},
    );
  }

  @Post('maintenance/scenes/beliefs')
  @RequireScopes('brain:admin')
  async promoteBeliefs(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; conversationId?: string } = {},
  ): Promise<BeliefPromotionResult> {
    // Double-gate idiom: controller 404 here + the service's defensive
    // early return (off = zero queries, byte-identical prod).
    if (!sceneSegmentationEnabled() || !sceneBeliefPromotionEnabled()) {
      throw new NotFoundException();
    }
    const tenant = this.resolveTenant(req, body.tenant);
    return this.beliefs.run(
      tenant,
      body.conversationId !== undefined ? { conversationId: body.conversationId } : {},
    );
  }

  @Delete('maintenance/scenes/versions/:segmenterVersion')
  @RequireScopes('brain:admin')
  async purgeVersion(
    @Req() req: AuthenticatedRequest,
    @Param('segmenterVersion') segmenterVersion: string,
    @Body() body: { tenant?: string } = {},
  ): Promise<{ scenes: number; members: number }> {
    if (!sceneSegmentationEnabled()) throw new NotFoundException();
    const version = (segmenterVersion ?? '').trim();
    if (version === '' || version.length > SEGMENTER_VERSION_MAX_CHARS) {
      throw new BadRequestException(
        `segmenterVersion must be non-empty and at most ${SEGMENTER_VERSION_MAX_CHARS} characters`,
      );
    }
    const tenant = this.resolveTenant(req, body.tenant);
    return this.composer.purgeVersion(tenant, version);
  }

  /** ONE tenant-resolution seam for every scene verb (0104 cache facade). */
  private resolveTenant(req: AuthenticatedRequest, requested: string | undefined): string {
    return resolvePlatformTenant(req, requested, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
  }
}
