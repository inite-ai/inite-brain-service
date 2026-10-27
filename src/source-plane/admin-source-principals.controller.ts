import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { MembershipService } from '../auth/membership.service';
import { sourcePlaneEnabled, sourcePrincipalsEnabled } from '../common/source-plane-flags';
import {
  isConnectionId,
  SourcePrincipalLinkRequestSchema,
  type SourcePrincipalsResponse,
} from '../contracts/source-plane/source-plane.schema';
import { SourceConnectionService } from './source-connection.service';

/**
 * The ACL mirror an operator can see and correct (W5).
 *
 * The plane refuses to guess who an external account is, so this is
 * where a human says it: `GET :id/principals` lists every account a
 * connection's `principals()` walk saw and the groups it is in, and
 * `POST :id/principals/link` binds one to a brain user (or unbinds it,
 * `userId: null`). Both halves are `brain:admin` — a membership edit is
 * an access-control edit.
 *
 * Nothing here runs a walk: the walk is part of a sync, so the tuples
 * and the items they fence are always written by the same run.
 */
@Controller('v1/admin/source-connections')
@UseGuards(ApiKeyGuard)
export class AdminSourcePrincipalsController {
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly membership: MembershipService,
  ) {}

  @Get(':id/principals')
  @RequireScopes('brain:admin')
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SourcePrincipalsResponse> {
    assertEnabled();
    const connectionId = assertId(id);
    const companyId = req.brainAuth.companyId;
    await this.connections.get(companyId, connectionId);
    const [identities, tuples, epoch] = await Promise.all([
      this.membership.identities(companyId, connectionId),
      this.membership.tuplesOf(companyId, connectionId),
      this.membership.epoch(companyId),
    ]);
    return {
      epoch,
      identities: identities.map((i) => ({
        externalId: i.externalId,
        handle: i.handle,
        displayName: i.displayName,
        email: i.email,
        userId: i.userId,
        linkedBy: i.linkedBy,
      })),
      tuples: tuples.map((t) => ({
        subject: t.subject,
        object: t.object,
        source: t.source,
        recordedAt: t.recordedAt,
        revokedAt: t.revokedAt,
      })),
    };
  }

  @Post(':id/principals/link')
  @RequireScopes('brain:admin')
  async link(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SourcePrincipalsResponse> {
    assertEnabled();
    const connectionId = assertId(id);
    const parsed = SourcePrincipalLinkRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const companyId = req.brainAuth.companyId;
    await this.connections.get(companyId, connectionId);
    await this.membership.link({
      companyId,
      connectionId,
      externalId: parsed.data.externalId,
      userId: parsed.data.userId ?? null,
      linkedBy: 'operator',
    });
    return this.list(req, id);
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled() || !sourcePrincipalsEnabled()) throw new NotFoundException();
}

function assertId(id: string): string {
  if (!isConnectionId(id)) throw new BadRequestException('invalid connection id');
  return id;
}
