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
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { sourcePlaneEnabled } from '../common/source-plane-flags';
import {
  isConnectionId,
  type SourceConnectionStats,
  type SourceItemInspectResponse,
  type SourceRunsResponse,
} from '../contracts/source-plane/source-plane.schema';
import { SourceConnectionService } from './source-connection.service';
import { SourceInspectService } from './source-inspect.service';
import { SourceRunHistoryService } from './source-run-history.service';

const ITEM_ID = /^(source_item:)?[A-Za-z0-9_-]{1,64}$/;

/**
 * The read-only drill-down of the operator surface — what a connection
 * produced (stats), every run it had (runs) and one catalogue row
 * followed to its document, asset and facts (items/:itemId). Same root
 * as the connections controller, deeper paths only, so `GET :id` there
 * never swallows these.
 */
@Controller('v1/admin/source-connections')
@UseGuards(ApiKeyGuard)
export class AdminSourceInspectController {
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly inspect: SourceInspectService,
    private readonly history: SourceRunHistoryService,
  ) {}

  @Get(':id/stats')
  @RequireScopes('brain:admin')
  async stats(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SourceConnectionStats> {
    assertEnabled();
    const connectionId = assertId(id);
    await this.connections.get(req.brainAuth.companyId, connectionId);
    return this.inspect.stats(req.brainAuth.companyId, connectionId);
  }

  @Get(':id/runs')
  @RequireScopes('brain:admin')
  async runs(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<SourceRunsResponse> {
    assertEnabled();
    const connectionId = assertId(id);
    await this.connections.get(req.brainAuth.companyId, connectionId);
    return this.history.list(req.brainAuth.companyId, connectionId, Number(limit ?? 20) || 20);
  }

  @Get(':id/items/:itemId')
  @RequireScopes('brain:admin')
  async item(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<SourceItemInspectResponse> {
    assertEnabled();
    const connectionId = assertId(id);
    if (!ITEM_ID.test(itemId)) throw new BadRequestException('invalid item id');
    await this.connections.get(req.brainAuth.companyId, connectionId);
    return this.inspect.item(req.brainAuth.companyId, {
      connectionId,
      itemId: itemId.startsWith('source_item:') ? itemId : `source_item:${itemId}`,
    });
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled()) throw new NotFoundException();
}

function assertId(id: string): string {
  if (!isConnectionId(id)) throw new BadRequestException('invalid connection id');
  return id;
}
