import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { envFlagNotDisabled } from '../common/env-validation';
import { AuthenticatedRequest } from '../auth/api-key.types';
import {
  SCENES_LIST_DEFAULT,
  SCENES_LIST_MAX,
  ScenesService,
  type SceneReadResult,
  type ScenesListResult,
} from './scenes.service';

interface SceneListQuery {
  conversationId?: string;
  entityId?: string;
  userId?: string;
  since?: string;
  until?: string;
  limit?: string;
}

function parseIsoOrThrow(name: string, v?: string): string | undefined {
  if (v === undefined) return undefined;
  if (Number.isNaN(Date.parse(v)))
    throw new BadRequestException(`${name} must be an ISO date-time`);
  return new Date(v).toISOString();
}

@Controller('v1/scenes')
@UseGuards(ApiKeyGuard)
export class ScenesController {
  constructor(private readonly scenes: ScenesService) {}

  /**
   * Read-surface gate (SCENES_API_ENABLED, DEFAULT ON; `=0` for a 404
   * indistinguishable from an absent route — the BELIEFS_API_ENABLED
   * idiom). Read at call time so a flip is runtime-mutable.
   */
  private assertEnabled(): void {
    if (!envFlagNotDisabled(process.env.SCENES_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('list_scenes')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: SceneListQuery,
  ): Promise<ScenesListResult> {
    this.assertEnabled();
    const limitRaw = q.limit !== undefined ? parseInt(q.limit, 10) : SCENES_LIST_DEFAULT;
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      throw new BadRequestException(`limit must be 1..${SCENES_LIST_MAX}`);
    }
    return this.scenes.listScenes({
      companyId: req.brainAuth.companyId,
      scopes: req.brainAuth.scopes,
      userId: q.userId,
      conversationId: q.conversationId,
      entityId: q.entityId,
      since: parseIsoOrThrow('since', q.since),
      until: parseIsoOrThrow('until', q.until),
      limit: Math.min(limitRaw, SCENES_LIST_MAX),
    });
  }

  @Get(':id')
  @RequireScopes('brain:read')
  @PolicyAction('get_scene')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<SceneReadResult> {
    this.assertEnabled();
    return this.scenes.getScene({
      companyId: req.brainAuth.companyId,
      sceneId: id,
      scopes: req.brainAuth.scopes,
    });
  }
}
