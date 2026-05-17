import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { SearchService } from './search.service';
import { SearchDto } from './dto/search.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/search')
@UseGuards(ApiKeyGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @RequireScopes('brain:read')
  @Throttle({ search: { limit: 60, ttl: 60_000 } })
  async run(@Req() req: AuthenticatedRequest, @Body() body: SearchDto) {
    return this.search.search(
      req.brainAuth.companyId,
      body,
      req.brainAuth.scopes,
    );
  }
}
