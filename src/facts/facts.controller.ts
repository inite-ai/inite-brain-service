import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { envFlagEnabled } from '../common/env-validation';
import { FactsService } from './facts.service';
import { RetractFactDto } from './dto/retract.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/facts')
@UseGuards(ApiKeyGuard)
export class FactsController {
  constructor(private readonly facts: FactsService) {}

  /**
   * Read-surface gate (FACTS_API_ENABLED, default off → 404 —
   * indistinguishable from an absent route; same pattern as
   * EPISODES_API_ENABLED). Applies ONLY to the GET routes: retract is a
   * write/GDPR path and stays flag-independent — a tenant must always be
   * able to remove a fact, whether or not the read API is switched on.
   */
  private assertEnabled(): void {
    if (!envFlagEnabled(process.env.FACTS_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  /** The fact itself — "what do you remember, and where is it from". */
  @Get(':id')
  @RequireScopes('brain:read')
  @PolicyAction('get_fact')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    this.assertEnabled();
    return this.facts.getFact({
      companyId: req.brainAuth.companyId,
      factId: id,
      scopes: req.brainAuth.scopes,
    });
  }

  /** Grounding episodes — "show me why I remember this". */
  @Get(':id/provenance')
  @RequireScopes('brain:read')
  @PolicyAction('get_fact_provenance')
  async provenance(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    this.assertEnabled();
    return this.facts.getProvenance({
      companyId: req.brainAuth.companyId,
      factId: id,
      scopes: req.brainAuth.scopes,
    });
  }

  // Default scope is brain:write; FactsService elevates to brain:admin
  // for billing_event / human_declared / source.kind='legal' facts —
  // see RETRACT_ADMIN_PREDICATES in facts.service.ts. Callers with only
  // brain:write get a 403 from there if the fact falls in that class,
  // not at the controller, because we don't know the predicate until
  // we read the row.
  @Post(':id/retract')
  @RequireScopes('brain:write')
  @PolicyAction('retract_fact')
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
