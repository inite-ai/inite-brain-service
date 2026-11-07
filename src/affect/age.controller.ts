import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import { AgeService, type AgeWire } from './age.service';
import type { RevocationErasure } from './consent.service';

/**
 * A person's age assurance and guardian (#916 step 1). Reading is the
 * person's (their own token) or the operator's; RECORDING is the
 * operator's alone — an M2M key attests what it checked. A user-bound
 * token cannot declare itself an adult or name its own guardian.
 */
@Controller('v1/users')
@UseGuards(ApiKeyGuard)
export class AgeController {
  constructor(private readonly ages: AgeService) {}

  @Get(':userId/age')
  @RequireScopes('brain:read')
  @PolicyAction('rest.users.age.get')
  async getAge(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<AgeWire> {
    const age = await this.ages.get(req.brainAuth.companyId, pinUserScope(userId) ?? userId);
    if (!age) throw new NotFoundException('no age recorded for this person');
    return age;
  }

  @Put(':userId/age')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.age.set')
  async setAge(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: { status?: string; minor?: unknown; ageBand?: string; method?: string },
  ): Promise<{ age: AgeWire; erased: Record<string, RevocationErasure> }> {
    operatorOnly(req);
    return this.ages.set({
      companyId: req.brainAuth.companyId,
      userId,
      status: body?.status ?? '',
      minor: body?.minor,
      ageBand: body?.ageBand,
      method: body?.method,
      recordedBy: req.brainAuth.actorId ?? req.brainAuth.keyHash,
    });
  }

  @Put(':userId/guardian')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.guardian.set')
  async setGuardian(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: { guardianRef?: string },
  ): Promise<AgeWire | { userId: string; guardian: { guardianRef: string } }> {
    operatorOnly(req);
    const age = await this.ages.setGuardian({
      companyId: req.brainAuth.companyId,
      userId,
      guardianRef: body?.guardianRef ?? '',
      recordedBy: req.brainAuth.actorId ?? req.brainAuth.keyHash,
    });
    return age ?? { userId, guardian: { guardianRef: body?.guardianRef ?? '' } };
  }

  @Delete(':userId/guardian')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.guardian.remove')
  async removeGuardian(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<{ removed: boolean; erased: Record<string, RevocationErasure> }> {
    operatorOnly(req);
    return this.ages.removeGuardian(req.brainAuth.companyId, userId);
  }
}

/** Age and guardians are attested by the operator, never by the person's own token. */
export function operatorOnly(req: AuthenticatedRequest): void {
  if (req.brainAuth.userId) {
    throw new ForbiddenException('age and guardians are recorded by the operator (an M2M key)');
  }
}
