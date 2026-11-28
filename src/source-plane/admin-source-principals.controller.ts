import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { getRequestContext } from '../common/request-context';
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
    const readPii = req.brainAuth.scopes.includes('brain:read_pii');
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
        // An address is PII: brain:admin opens the route, brain:read_pii
        // is what shows the value (null otherwise, the "unknown" shape).
        email: readPii ? i.email : null,
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
    const userId = parsed.data.userId ?? null;
    await this.assertMayLink(companyId, {
      connectionId,
      externalId: parsed.data.externalId,
      userId,
    });
    await this.membership.link({
      companyId,
      connectionId,
      externalId: parsed.data.externalId,
      userId,
      linkedBy: 'operator',
    });
    return this.list(req, id);
  }

  /**
   * A link hands the account's groups — its scope tags — to a brain
   * user, so it is an access grant. A user-bound key holds one user's
   * slice of the tenant: it may claim an account for itself or let go of
   * its own, never bind one to (or take one from) another user. A
   * tenant-wide key keeps its authority.
   */
  private async assertMayLink(
    companyId: string,
    p: { connectionId: string; externalId: string; userId: string | null },
  ): Promise<void> {
    const authUserId = getRequestContext()?.authUserId;
    if (!authUserId) return;
    if (p.userId !== null && p.userId !== authUserId) {
      throw new ForbiddenException(
        'userId does not match the authenticated user scope of this token',
      );
    }
    const identities = await this.membership.identities(companyId, p.connectionId);
    const current = identities.find((i) => i.externalId === p.externalId)?.userId ?? null;
    if (current !== null && current !== authUserId) {
      throw new ForbiddenException('this account is linked to another user');
    }
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled() || !sourcePrincipalsEnabled()) throw new NotFoundException();
}

function assertId(id: string): string {
  if (!isConnectionId(id)) throw new BadRequestException('invalid connection id');
  return id;
}
