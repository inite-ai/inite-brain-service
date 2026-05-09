import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { DreamsService } from './dreams.service';
import { RunDreamsDto } from './dto/run-dreams.dto';

/**
 * `POST /v1/dreams/run` — manual trigger for the off-hours dreams
 * pass. Scoped to brain:admin because the operations mutate state
 * that no other v1 endpoint exposes (auto-emit identity_of links,
 * auto-supersede competing facts).
 *
 * Body: `{ operations?: ('dedup'|'resolve'|'summarize')[] }`. Empty /
 * unset uses the env-default subset.
 */
@Controller('v1/dreams')
@UseGuards(ApiKeyGuard)
export class DreamsController {
  constructor(private readonly dreams: DreamsService) {}

  @Post('run')
  @RequireScopes('brain:admin')
  async run(@Req() req: AuthenticatedRequest, @Body() body: RunDreamsDto) {
    return this.dreams.runForTenant(
      req.brainAuth.companyId,
      body.operations ?? ['dedup', 'resolve'],
    );
  }
}
