import { Module } from '@nestjs/common';
import { MriAdminController } from './mri-admin.controller';
import { MriService } from './mri.service';

/**
 * MRI module (measurable-economics-mri-2026-08.md). Read-only reporting layer:
 * the admin endpoint + the report generator. MetricsService arrives from the
 * global MetricsModule; ApiKeyGuard's deps come from the global auth/policy
 * modules — no imports needed (mirrors StrategyModule).
 */
@Module({
  controllers: [MriAdminController],
  providers: [MriService],
  exports: [MriService],
})
export class MriModule {}
