import { Controller, Get, NotFoundException, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { MriService } from './mri.service';
import type { MriReport } from './mri.types';
import type { PolicyOperatingPoint } from './economics';

/**
 * MRI admin surface (measurable-economics-mri-2026-08.md §1-2).
 *
 * Operator / eval-harness only. Authenticated by ApiKeyGuard, but the handler
 * itself 404s when the caller lacks `brain:admin` — indistinguishable from
 * "route not deployed" (the EPISODES_API / focus-admin idiom). This surface is
 * READ-ONLY: it serves the latest generated snapshot of live telemetry + the
 * suite-status ledger; nothing here touches the answer path.
 *
 * Deliberately NOT in the platform OpenAPI document — the admin/ops surface is
 * out of scope there by design (scripts/build-openapi.ts). The wire contract is
 * pinned by test/contracts-admin-mri.unit-spec.ts against MriReportSchema, the
 * same way the calibration cockpit is.
 */
@Controller('v1/admin/mri')
@UseGuards(ApiKeyGuard)
export class MriAdminController {
  constructor(private readonly mri: MriService) {}

  private assertAdmin(req: AuthenticatedRequest): void {
    if (!req.brainAuth.scopes.includes('brain:admin')) {
      throw new NotFoundException();
    }
  }

  /** The full MRI report — §2 dimensions + the §1 live operating point. */
  @Get()
  async report(@Req() req: AuthenticatedRequest): Promise<MriReport> {
    this.assertAdmin(req);
    return this.mri.generate();
  }

  /** Just the Part 1 live operating point (proxy-accuracy × cost × latency). */
  @Get('operating-point')
  async operatingPoint(@Req() req: AuthenticatedRequest): Promise<PolicyOperatingPoint> {
    this.assertAdmin(req);
    const report = await this.mri.generate();
    return report.operatingPoint;
  }
}
