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
  sceneFactBacklinkEnabled,
  sceneLlmEnrichmentEnabled,
  sceneSegmentationEnabled,
} from '../common/scene-flags';
import { SceneComposerService, SceneRunResult } from './scene-composer.service';
import { SceneEnricherService, SceneEnrichResult } from './scene-enricher.service';
import { SceneBacklinkService, SceneBacklinkResult } from './scene-backlink.service';

/** Purge param belt: DB stamps are short version slugs, not free text. */
const SEGMENTER_VERSION_MAX_CHARS = 64;

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
