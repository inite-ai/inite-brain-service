import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { EntitiesService } from './entities.service';
import { ForgetEntityDto } from './dto/forget.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/entities')
@UseGuards(ApiKeyGuard)
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

  @Get(':id')
  @RequireScopes('brain:read')
  async getProfile(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.entities.getProfile(
      req.brainAuth.companyId,
      id,
      asOf,
      req.brainAuth.scopes,
    );
  }

  @Get(':id/timeline')
  @RequireScopes('brain:read')
  async getTimeline(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    return this.entities.getTimeline(
      req.brainAuth.companyId,
      id,
      since,
      until,
      req.brainAuth.scopes,
    );
  }

  @Get(':id/connections')
  @RequireScopes('brain:read')
  async getConnections(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('kind') kind?: string,
  ) {
    return this.entities.getConnections(
      req.brainAuth.companyId,
      id,
      kind,
      req.brainAuth.scopes,
    );
  }

  @Post(':id/forget')
  @RequireScopes('brain:admin')
  @Throttle({ forget: { limit: 5, ttl: 60_000 } })
  async forget(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ForgetEntityDto,
  ) {
    return this.entities.forget(req.brainAuth.companyId, id, body);
  }
}
