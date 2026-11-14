import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireAnyScope, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import {
  AffectPlaneService,
  type AffectEraseResult,
  type AffectEraseScope,
  type AffectExport,
} from './affect-plane.service';
import {
  ConsentService,
  type ConsentGrantor,
  type ConsentWire,
  type RevocationErasure,
} from './consent.service';
import { operatorOnly } from './age.controller';

/**
 * A person's rights over their emotional data and their consents (#909
 * step 3). Always on: these are rights, not features. A user-bound token
 * acts only for its own user (the pin answers 403 for another); an M2M
 * key acts for any user of its tenant — the operator answering a request.
 *
 * Emotional data is classed `affect`, so reading it needs brain:read_pii
 * like every other read of the class; erasing and contesting are writes.
 * Erasing and withdrawing a consent also accept brain:erase, which opens
 * nothing else here (not export, contest, list or record).
 */
@Controller('v1/users')
@UseGuards(ApiKeyGuard)
export class AffectController {
  constructor(
    private readonly affect: AffectPlaneService,
    private readonly consents: ConsentService,
  ) {}

  @Get(':userId/affect')
  @RequireScopes('brain:read', 'brain:read_pii')
  @PolicyAction('rest.users.affect.export')
  async exportAffect(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<AffectExport> {
    return this.affect.export({ companyId: req.brainAuth.companyId, userId: pinned(userId) });
  }

  // Erasing and withdrawing take brain:erase too: a product backend that
  // answers a person's erasure or withdrawal holds only that (api-key.types.ts).
  @Delete(':userId/affect')
  @RequireAnyScope('brain:write', 'brain:erase')
  @PolicyAction('rest.users.affect.erase')
  async eraseAffect(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Query('scope') scope?: string,
  ): Promise<AffectEraseResult> {
    const which = scope ?? 'all';
    if (which !== 'all' && which !== 'inferred') {
      throw new BadRequestException("scope must be 'all' or 'inferred'");
    }
    return this.affect.erase({
      companyId: req.brainAuth.companyId,
      userId: pinned(userId),
      scope: which as AffectEraseScope,
    });
  }

  @Post(':userId/affect/:id/contest')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.affect.contest')
  async contest(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('id') id: string,
  ): Promise<{ contested: string; erased: AffectEraseResult }> {
    return this.affect.contest({ companyId: req.brainAuth.companyId, userId: pinned(userId), id });
  }

  @Get(':userId/consents')
  @RequireScopes('brain:read')
  @PolicyAction('rest.users.consents.list')
  async listConsents(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<{ consents: ConsentWire[] }> {
    return {
      consents: await this.consents.list({
        companyId: req.brainAuth.companyId,
        userId: pinned(userId),
      }),
    };
  }

  @Post(':userId/consents')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.consents.record')
  async recordConsent(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body()
    body: { purpose?: string; basis?: string; noticeVersion?: string; grantedBy?: string },
  ): Promise<ConsentWire> {
    // A guardian's grant is attested by the operator, never by the child's token.
    if (body?.grantedBy === 'guardian') operatorOnly(req);
    return this.consents.record({
      companyId: req.brainAuth.companyId,
      userId: pinned(userId),
      purpose: body?.purpose ?? '',
      basis: body?.basis ?? '',
      noticeVersion: body?.noticeVersion ?? '',
      recordedBy: req.brainAuth.actorId ?? req.brainAuth.keyHash,
      grantedBy: body?.grantedBy as ConsentGrantor | undefined,
    });
  }

  @Delete(':userId/consents/:purpose')
  @RequireAnyScope('brain:write', 'brain:erase')
  @PolicyAction('rest.users.consents.revoke')
  async revokeConsent(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('purpose') purpose: string,
  ): Promise<{ purpose: string; revoked: boolean; erased: RevocationErasure }> {
    return this.consents.revoke({
      companyId: req.brainAuth.companyId,
      userId: pinned(userId),
      purpose,
    });
  }
}

/** A user-bound token acts only for itself (403 otherwise); M2M for any user. */
function pinned(userId: string): string {
  return pinUserScope(userId) ?? userId;
}
