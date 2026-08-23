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
import { AuthenticatedRequest } from '../auth/api-key.types';
import { envFlagEnabled } from '../common/env-validation';
import { pinUserScope } from '../auth/user-scope';
import { UserProfileService } from './user-profile.service';
import { DEFAULT_MAX_FACTS, HARD_MAX_FACTS, type UserProfileWire } from './dto/user-profile.dto';

/**
 * Rolling user profile v1: GET /v1/users/:userId/profile — a
 * deterministic, prompt-injectable projection of one end-user's
 * memory. Gated by USER_PROFILE_API_ENABLED (default off → 404,
 * indistinguishable from an absent route — the episodes-API precedent).
 *
 * Auth follows the user-scope pin (0055): an M2M credential may fetch
 * any user's profile; a user-bound token only its own (mismatch → 403).
 */
@Controller('v1/users')
@UseGuards(ApiKeyGuard)
export class UserProfileController {
  constructor(private readonly profiles: UserProfileService) {}

  private assertEnabled(): void {
    if (!envFlagEnabled(process.env.USER_PROFILE_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Query binding, cannot be folded into an options object without breaking Nest param resolution
  @Get(':userId/profile')
  @RequireScopes('brain:read')
  @PolicyAction('get_user_profile')
  async getProfile(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Query('maxFacts') maxFacts?: string,
    @Query('lang') lang?: string,
  ): Promise<UserProfileWire> {
    this.assertEnabled();
    // A user-bound token may read only its own profile — the pin
    // throws 403 when the path names another user. M2M reads any.
    const pinned = pinUserScope(userId) ?? userId;
    const parsed = maxFacts !== undefined ? parseInt(maxFacts, 10) : DEFAULT_MAX_FACTS;
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new BadRequestException(`maxFacts must be 1..${HARD_MAX_FACTS}`);
    }
    return this.profiles.getProfile({
      companyId: req.brainAuth.companyId,
      userId: pinned,
      callerScopes: req.brainAuth.scopes,
      maxFacts: Math.min(parsed, HARD_MAX_FACTS),
      lang: lang?.trim() || undefined,
    });
  }
}
