import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { AgentQaService } from './agent-qa.service';
import { AgentQaDto } from './dto/agent-qa.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/answer')
@UseGuards(ApiKeyGuard)
export class AgentQaController {
  constructor(private readonly agentQa: AgentQaService) {}

  @Post()
  @RequireScopes('brain:read')
  @PolicyAction('agent_qa')
  // Iterative LLM loop over search — several LLM + search rounds → expensive.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async answer(@Req() req: AuthenticatedRequest, @Body() body: AgentQaDto) {
    return this.agentQa.answer({
      companyId: req.brainAuth.companyId,
      question: body.query,
      callerScopes: req.brainAuth.scopes,
      asOf: body.asOf,
    });
  }
}
