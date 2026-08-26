import { Body, Controller, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { sceneSegmentationEnabled } from '../common/scene-flags';
import { SceneComposerService, SceneRunResult } from './scene-composer.service';

/**
 * Explicit trigger for the Brain v2 scene composer (shadow memory_episode
 * substrate, migration 0106). LLM-free; embedding cost only when
 * SCENES_TOPIC_BOUNDARY is on. Idempotent per (conversation ×
 * segmenterVersion) — atomic delete-then-insert swap. Flag off ⇒ the
 * route 404s (SCENES_SEGMENTATION_ENABLED, read at call time).
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminScenesController {
  constructor(
    private readonly composer: SceneComposerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/scenes')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string; conversationId?: string } = {},
  ): Promise<SceneRunResult> {
    if (!sceneSegmentationEnabled()) throw new NotFoundException();
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    return this.composer.run(
      tenant,
      body.conversationId !== undefined ? { conversationId: body.conversationId } : {},
    );
  }
}
