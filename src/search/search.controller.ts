import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { SearchService } from './search.service';
import { SearchDto } from './dto/search.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/search')
@UseGuards(ApiKeyGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  // Fans out to embedding + (optionally LLM) cross-encoder/reranker —
  // every search can hit the shared OpenAI budget. Put it in the tight
  // per-credential `expensive` bucket like synthesize/multi-hop so one
  // compromised tenant can't drain the token budget at the 120/min
  // default rate. See app.module.ts throttler config.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  @Post()
  @RequireScopes('brain:read')
  @PolicyAction('search_knowledge')
  async run(@Req() req: AuthenticatedRequest, @Body() body: SearchDto) {
    return this.search.search(
      req.brainAuth.companyId,
      body,
      req.brainAuth.scopes,
    );
  }
}
