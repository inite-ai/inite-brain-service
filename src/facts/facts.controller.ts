import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { FactsService } from './facts.service';
import { RetractFactDto } from './dto/retract.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/facts')
@UseGuards(ApiKeyGuard)
export class FactsController {
  constructor(private readonly facts: FactsService) {}

  @Post(':id/retract')
  @RequireScopes('brain:write')
  async retract(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: RetractFactDto,
  ) {
    return this.facts.retract(req.brainAuth.companyId, id, body);
  }
}
