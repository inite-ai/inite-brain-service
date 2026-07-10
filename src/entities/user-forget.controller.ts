import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { UserForgetService, UserForgetResult } from './user-forget.service';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { Req } from '@nestjs/common';

@Controller('v1/users')
@UseGuards(ApiKeyGuard)
export class UserForgetController {
  constructor(private readonly userForget: UserForgetService) {}

  /**
   * GDPR erasure of one end-user's personal memory scope. Same guard
   * tier as entity forget (brain:admin) — hard destructive cascade.
   */
  @Post(':userId/forget')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.users.forget')
  async forget(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<UserForgetResult> {
    return this.userForget.forgetUser(req.brainAuth.companyId, userId);
  }
}
