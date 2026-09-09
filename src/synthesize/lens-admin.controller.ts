import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { LensSuppressionService, type LensSuppressionFitClass } from './lens-suppression.service';

/**
 * Fovea optics admin surface (Optics §4.3) — load + fit the lens-suppression
 * model. Companion to docs/roadmap/fovea-optics-2026-08.md §4.3.
 *
 * Operator / eval-harness only (brain:admin). Gated by the same master flag
 * as the governor: with FOVEA_LENS_SUPPRESS off the whole feature is dormant,
 * so these routes 404 (indistinguishable from absent — the focus-admin
 * idiom). The `fit` is a THIN INGEST of externally-mined (class, centroid,
 * suppressLanes) rows — the training data is offline/parked, so this surface
 * persists provided rows rather than learning at serving time.
 *
 * Because the centroid arrives from outside, it is the one vector in the
 * system that never passes EmbedderService and therefore never met #503's
 * cross-space write guard. The width/space check now lives in the service
 * (LensSuppressionService.assertCentroidSpace) rather than here, so it
 * covers every caller of `fitAndPersist` and not merely this route; the
 * shape validation below stays where it is.
 */
@Controller('v1/admin/lens-suppression')
@UseGuards(ApiKeyGuard)
export class LensAdminController {
  constructor(private readonly lens: LensSuppressionService) {}

  private assertEnabled(): void {
    if (!LensSuppressionService.suppressEnabled()) throw new NotFoundException();
  }

  /** List the latest suppression class per classId (max version). */
  @Get('classes')
  @RequireScopes('brain:admin')
  async classes(@Req() req: AuthenticatedRequest): Promise<{
    classes: Array<{
      classId: string;
      suppressLanes: string[];
      sampleCount: number;
      version: number;
      centroidDim: number;
      /** The space stamp (0132). NULL = written before the guard existed. */
      embeddingSpaceId: string | null;
    }>;
  }> {
    this.assertEnabled();
    const rows = await this.lens.listClasses(req.brainAuth.companyId);
    return { classes: rows };
  }

  /** Ingest externally-mined per-class suppression rows (versioned). */
  @Post('fit')
  @RequireScopes('brain:admin')
  async fit(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      classes?: Array<{
        classId?: unknown;
        centroid?: unknown;
        suppressLanes?: unknown;
        sampleCount?: unknown;
        embeddingSpaceId?: unknown;
      }>;
    },
  ): Promise<{ persisted: number; classes: string[] }> {
    this.assertEnabled();
    const raw = body?.classes;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('classes[] required and must be non-empty');
    }
    const classes: LensSuppressionFitClass[] = raw.map((c) => {
      if (
        !c ||
        typeof c.classId !== 'string' ||
        c.classId.trim() === '' ||
        !Array.isArray(c.centroid) ||
        !c.centroid.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
        !Array.isArray(c.suppressLanes) ||
        !c.suppressLanes.every((l) => typeof l === 'string') ||
        typeof c.sampleCount !== 'number' ||
        !Number.isFinite(c.sampleCount) ||
        c.sampleCount < 0
      ) {
        throw new BadRequestException(
          'each class needs a classId, a numeric centroid[], a string suppressLanes[], and a non-negative sampleCount',
        );
      }
      // Required, and not free-form: the declared space is an assertion the
      // service checks against the tenant's primary space. A width check
      // alone cannot tell two models of the same width apart, and a
      // centroid from the wrong model is durable — there is no source text
      // to re-embed it from.
      if (typeof c.embeddingSpaceId !== 'string' || c.embeddingSpaceId.trim() === '') {
        throw new BadRequestException(
          'each class must declare embeddingSpaceId — the space the centroid was mined in ' +
            '(provider:model:dim:norm, e.g. bge-m3:Xenova/bge-m3:1024:l2)',
        );
      }
      return {
        classId: c.classId,
        centroid: c.centroid as number[],
        suppressLanes: c.suppressLanes as string[],
        sampleCount: c.sampleCount,
        embeddingSpaceId: c.embeddingSpaceId,
      };
    });
    return this.lens.fitAndPersist(req.brainAuth.companyId, classes);
  }
}
