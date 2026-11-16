import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import {
  RetentionSetRequestSchema,
  type RetentionResponse,
} from '../contracts/admin/retention.schema';
import { FAMILY_RETENTION_DAYS, UserRetentionService } from './user-retention.service';

/**
 * The tenant's retention rule (UserRetentionService). Erasing people on a
 * clock is the tenant's decision, so it is `brain:admin` on its own
 * tenant; a platform operator reaches another tenant through the usual
 * tenant override.
 */
@Controller('v1/admin/retention')
@UseGuards(ApiKeyGuard)
export class UserRetentionController {
  constructor(private readonly retention: UserRetentionService) {}

  @Get()
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.retention.get')
  async get(@Req() req: AuthenticatedRequest): Promise<RetentionResponse> {
    const companyId = req.brainAuth.companyId;
    const days = await this.retention.policy(companyId);
    return { companyId, userInactiveDays: days, familyDefaultDays: FAMILY_RETENTION_DAYS };
  }

  @Put()
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.retention.set')
  async set(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<RetentionResponse> {
    const parsed = RetentionSetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'userInactiveDays must be an integer from 30 to 3650, or null to turn retention off',
      );
    }
    const companyId = req.brainAuth.companyId;
    const days = parsed.data.userInactiveDays;
    await this.retention.setPolicy(companyId, days);
    return { companyId, userInactiveDays: days, familyDefaultDays: FAMILY_RETENTION_DAYS };
  }
}
