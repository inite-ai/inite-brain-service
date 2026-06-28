import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { FactsService } from './facts.service';
import { RetractFactDto } from './dto/retract.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/facts')
@UseGuards(ApiKeyGuard)
export class FactsController {
  constructor(private readonly facts: FactsService) {}

  // Default scope is brain:write; FactsService elevates to brain:admin
  // for billing_event / human_declared / source.kind='legal' facts —
  // see RETRACT_ADMIN_PREDICATES in facts.service.ts. Callers with only
  // brain:write get a 403 from there if the fact falls in that class,
  // not at the controller, because we don't know the predicate until
  // we read the row.
  @Post(':id/retract')
  @RequireScopes('brain:write')
  async retract(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: RetractFactDto,
  ) {
    return this.facts.retract({
      companyId: req.brainAuth.companyId,
      factId: id,
      dto: body,
      callerScopes: req.brainAuth.scopes,
    });
  }
}
