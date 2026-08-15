import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { envFlagEnabled } from '../common/env-validation';
import {
  ProjectionRegistryService,
  type ProjectionRow,
} from '../episodes/projection-registry.service';
import { ReadPinService } from '../episodes/read-pin.service';
import {
  WindowDeriverService,
  WINDOW_DERIVER_VERSION,
  type DeriveRunResult,
} from './window-deriver.service';
import { throwIfDeriveFailed } from './admin-derive.controller';

/**
 * Public projections API (raw-substrate driver v1, surface 3 —
 * docs/roadmap/raw-substrate-driver-2026-08.md): derived surfaces as
 * first-class records, and rebuild as the public verb over the
 * maintenance batch engine. Gated by PROJECTIONS_API_ENABLED (default
 * off → 404, indistinguishable from an absent route).
 *
 * v1 rebuilds one projection name: 'facts' (the session-window
 * deriver). Segments/communities join as their builders migrate onto
 * the registry.
 */
const REBUILDABLE = new Set(['facts']);

@Controller('v1/projections')
@UseGuards(ApiKeyGuard)
export class ProjectionsController {
  constructor(
    private readonly registry: ProjectionRegistryService,
    private readonly deriver: WindowDeriverService,
    private readonly readPin: ReadPinService,
  ) {}

  private gate(): void {
    if (!envFlagEnabled(process.env.PROJECTIONS_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('rest.projections.list')
  async list(@Req() req: AuthenticatedRequest): Promise<{
    projections: ProjectionRow[];
    /**
     * The live derived world for THIS tenant: the registry's `live` row,
     * or the env bootstrap default when no row exists yet (audit W2 #9 —
     * this used to report the pod's env, contradicting the registry).
     */
    readPin: string | null;
  }> {
    this.gate();
    return {
      projections: await this.registry.list(req.brainAuth.companyId),
      readPin: await this.readPin.resolve(req.brainAuth.companyId),
    };
  }

  @Post(':name/rebuild')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.projections.rebuild')
  async rebuild(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
    @Body()
    body: {
      version?: string;
      conversation?: string;
      /** Flip the live read pin to this version after a successful run. */
      activate?: boolean;
      /** Allow rewriting the currently pinned world in place (eval only). */
      force?: boolean;
    } = {},
  ): Promise<DeriveRunResult> {
    this.gate();
    if (!REBUILDABLE.has(name)) {
      throw new BadRequestException(
        `Unknown projection '${name}' — rebuildable: ${[...REBUILDABLE].join(', ')}`,
      );
    }
    const version = body.version?.trim() || WINDOW_DERIVER_VERSION;
    if (!/^[a-z0-9-]{2,32}$/.test(version)) {
      throw new BadRequestException(
        'version must be a short kebab-case tag (e.g. wd-v2)',
      );
    }
    const conversationId = body.conversation?.trim() || undefined;
    if (conversationId && conversationId.length > 128) {
      throw new BadRequestException('conversation id too long');
    }
    try {
      return throwIfDeriveFailed(
        await this.deriver.run(req.brainAuth.companyId, {
          version,
          conversationId,
          activate: body.activate === true,
          force: body.force === true,
        }),
      );
    } catch (e) {
      // The live-pin guard is a caller mistake, not a server fault.
      if ((e as Error).message.includes('live read pin')) {
        throw new BadRequestException((e as Error).message);
      }
      throw e;
    }
  }
}
