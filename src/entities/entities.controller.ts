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
    return this.entities.getProfile({
      companyId: req.brainAuth.companyId,
      entityIdRaw: id,
      asOfRaw: asOf,
      scopes: req.brainAuth.scopes,
    });
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Query binding, cannot be folded into an options object without breaking Nest param resolution
  @Get(':id/timeline')
  @RequireScopes('brain:read')
  async getTimeline(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    return this.entities.getTimeline({
      companyId: req.brainAuth.companyId,
      entityIdRaw: id,
      sinceRaw: since,
      untilRaw: until,
      scopes: req.brainAuth.scopes,
    });
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Query binding, cannot be folded into an options object without breaking Nest param resolution
  @Get(':id/connections')
  @RequireScopes('brain:read')
  async getConnections(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('kind') kind?: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.entities.getConnections({
      companyId: req.brainAuth.companyId,
      entityIdRaw: id,
      kind,
      scopes: req.brainAuth.scopes,
      asOf,
    });
  }

  @Post(':id/forget')
  @RequireScopes('brain:admin')
  async forget(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ForgetEntityDto,
  ) {
    return this.entities.forget({
      companyId: req.brainAuth.companyId,
      entityIdRaw: id,
      dto: body,
      actorKeyHash: req.brainAuth.keyHash,
    });
  }
}
