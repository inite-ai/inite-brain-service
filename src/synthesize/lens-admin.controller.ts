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
      return {
        classId: c.classId,
        centroid: c.centroid as number[],
        suppressLanes: c.suppressLanes as string[],
        sampleCount: c.sampleCount,
      };
    });
    return this.lens.fitAndPersist(req.brainAuth.companyId, classes);
  }
}
