import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { SynthesizeService } from './synthesize.service';
import { SynthesizeDto } from './dto/synthesize.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/synthesize')
@UseGuards(ApiKeyGuard)
export class SynthesizeController {
  constructor(private readonly synthesize: SynthesizeService) {}

  @Post()
  @RequireScopes('brain:read')
  // Generator + verifier each cost one chat completion; treat as expensive.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: SynthesizeDto,
  ) {
    return this.synthesize.synthesize({
      companyId: req.brainAuth.companyId,
      dto: body,
      callerScopes: req.brainAuth.scopes,
    });
  }
}
