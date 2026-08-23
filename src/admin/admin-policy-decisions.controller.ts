import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PolicyDecisionsService } from '../policy/policy-decisions.service';
import type {
  PolicyDecisionsResponse,
  PolicyDecisionsStatsResponse,
} from '../contracts/admin/policy-tools.schema';

/**
 * Read side of the policy_decision stream: the admin decisions feed
 * (cursor-paginated, filterable) and the report_only observability
 * aggregates behind the promote-to-enforce panel.
 */
@Controller('v1/admin/policy/decisions')
@UseGuards(ApiKeyGuard)
export class AdminPolicyDecisionsController {
  constructor(private readonly decisions: PolicyDecisionsService) {}

  @Get()
  @RequireScopes('brain:admin')
  async feed(
    @Req() req: AuthenticatedRequest,
    @Query()
    q: {
      policySet?: string;
      decision?: string;
      kind?: string;
      action?: string;
      limit?: string;
      before?: string;
    },
  ): Promise<PolicyDecisionsResponse> {
    const parsedLimit = q.limit ? parseInt(q.limit, 10) : undefined;
    return (await this.decisions.feed(req.brainAuth.companyId, {
      ...(q.policySet ? { policySet: q.policySet } : {}),
      ...(q.decision ? { decision: q.decision } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      ...(q.before ? { before: q.before } : {}),
    })) satisfies PolicyDecisionsResponse;
  }

  @Get('stats')
  @RequireScopes('brain:admin')
  async stats(
    @Req() req: AuthenticatedRequest,
    @Query('windowDays') windowDays?: string,
  ): Promise<PolicyDecisionsStatsResponse> {
    const days = windowDays ? parseInt(windowDays, 10) : 7;
    return (await this.decisions.stats(
      req.brainAuth.companyId,
      Number.isFinite(days) && days > 0 ? days : 7,
    )) satisfies PolicyDecisionsStatsResponse;
  }
}
