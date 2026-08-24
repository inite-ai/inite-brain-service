import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { FocusSignalService } from './focus-signal.service';

/**
 * Fovea optics admin surface (Optics-1) — fit + measure the focus signal.
 * Companion to docs/roadmap/fovea-optics-2026-08.md §3.
 *
 * Operator / eval-harness only (brain:admin). Gated by the same master
 * flag as capture: with FOVEA_FOCUS_CAPTURE off the whole feature is
 * dormant, so these routes 404 (indistinguishable from absent — the
 * EPISODES_API idiom). This surface is what runs the §3 ECE / reliability
 * measurement once labeled samples exist. It does NOT touch serving:
 * fitting persists a calibration nothing on the answer path reads yet.
 */
@Controller('v1/admin/focus')
@UseGuards(ApiKeyGuard)
export class FocusAdminController {
  constructor(private readonly focus: FocusSignalService) {}

  private assertEnabled(): void {
    if (!FocusSignalService.captureEnabled()) throw new NotFoundException();
  }

  /** Recent samples (sampleId + class + label state) for backfill discovery. */
  @Get('samples')
  @RequireScopes('brain:admin')
  async samples(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('unlabeled') unlabeled?: string,
  ): Promise<{
    samples: Array<{
      sampleId: string;
      queryClass: string;
      correct: number | null;
      createdAt: string | null;
    }>;
  }> {
    this.assertEnabled();
    const parsed = limit !== undefined ? parseInt(limit, 10) : undefined;
    const rows = await this.focus.listSamples(req.brainAuth.companyId, {
      ...(parsed !== undefined && Number.isFinite(parsed) ? { limit: parsed } : {}),
      onlyUnlabeled: unlabeled === '1' || unlabeled === 'true',
    });
    return { samples: rows };
  }

  /** Backfill outcome labels (the eval-harness path). */
  @Post('label')
  @RequireScopes('brain:admin')
  async label(
    @Req() req: AuthenticatedRequest,
    @Body() body: { labels?: Array<{ sampleId?: string; correct?: number }> },
  ): Promise<{ updated: number }> {
    this.assertEnabled();
    const raw = body?.labels;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('labels[] required and must be non-empty');
    }
    const labels = raw.map((l) => {
      if (!l || typeof l.sampleId !== 'string' || (l.correct !== 0 && l.correct !== 1)) {
        throw new BadRequestException('each label needs a sampleId and correct ∈ {0,1}');
      }
      return { sampleId: l.sampleId, correct: l.correct as 0 | 1 };
    });
    const updated = await this.focus.labelSamples(req.brainAuth.companyId, labels);
    return { updated };
  }

  /** Fit per-class isotonic calibration from labeled samples and persist. */
  @Post('fit')
  @RequireScopes('brain:admin')
  async fit(@Req() req: AuthenticatedRequest): Promise<{
    sampleCount: number;
    classes: Array<{ queryClass: string; bins: number; sampleCount: number }>;
  }> {
    this.assertEnabled();
    return this.focus.fitAndPersist(req.brainAuth.companyId);
  }

  /** The §3 reliability report (ECE + diagram, global and per-class). */
  @Get('reliability')
  @RequireScopes('brain:admin')
  async reliability(
    @Req() req: AuthenticatedRequest,
    @Query('bins') bins?: string,
  ): Promise<unknown> {
    this.assertEnabled();
    const parsed = bins !== undefined ? parseInt(bins, 10) : 10;
    const nBins = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 10;
    return this.focus.reliability(req.brainAuth.companyId, nBins);
  }
}
