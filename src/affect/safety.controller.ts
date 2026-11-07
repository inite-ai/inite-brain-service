import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import {
  SafetyEventService,
  type SafetyEventWire,
  type SafetyReportRow,
} from './safety-event.service';

/**
 * The operator's safety protocol record (#916 step 2): the agent records
 * what it showed a person; the tenant admin pulls the identifier-free
 * report. Always on — a record the law asks for is not a feature.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class SafetyController {
  constructor(private readonly events: SafetyEventService) {}

  @Post('users/:userId/safety-events')
  @RequireScopes('brain:write')
  @PolicyAction('rest.users.safety_events.record')
  async record(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: { type?: string; protocolVersion?: string; resource?: string },
  ): Promise<SafetyEventWire> {
    return this.events.record({
      companyId: req.brainAuth.companyId,
      userId: pinUserScope(userId) ?? userId,
      type: body?.type ?? '',
      protocolVersion: body?.protocolVersion ?? '',
      resource: body?.resource,
      recordedBy: req.brainAuth.actorId ?? req.brainAuth.keyHash,
    });
  }

  @Get('users/:userId/safety-events')
  @RequireScopes('brain:read')
  @PolicyAction('rest.users.safety_events.list')
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<{ events: SafetyEventWire[] }> {
    return {
      events: await this.events.list(req.brainAuth.companyId, pinUserScope(userId) ?? userId),
    };
  }

  @Get('admin/safety/report')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.admin.safety_report')
  async report(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ from: string; to: string; rows: SafetyReportRow[] }> {
    const f = new Date(from ?? '');
    const t = new Date(to ?? '');
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      throw new BadRequestException('from and to are ISO dates');
    }
    return {
      from: f.toISOString(),
      to: t.toISOString(),
      rows: await this.events.report(req.brainAuth.companyId, f, t),
    };
  }
}
