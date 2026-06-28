import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { MultiHopService } from './multi-hop.service';
import { MultiHopDto } from './dto/multi-hop.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/search/multi-hop')
@UseGuards(ApiKeyGuard)
export class MultiHopController {
  constructor(private readonly multiHop: MultiHopService) {}

  @Post()
  @RequireScopes('brain:read')
  // Planner + up to maxHops sub-searches + optional synthesize → expensive.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async run(@Req() req: AuthenticatedRequest, @Body() body: MultiHopDto) {
    return this.multiHop.run({
      companyId: req.brainAuth.companyId,
      dto: body,
      callerScopes: req.brainAuth.scopes,
    });
  }
}
