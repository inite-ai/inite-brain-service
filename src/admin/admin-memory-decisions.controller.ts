import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { MemoryDecisionsReadService } from '../outcomes/memory-decisions-read.service';
import type {
  MemoryDecisionsResponse,
  MemoryDecisionsStatsResponse,
} from '../contracts/admin/memory-decisions.schema';

/**
 * Read side of the serving-path decision stream (0119): the trace feed
 * (filterable, cursor-paginated, `?requestId=` pulls one request's whole
 * decision chain) and the aggregates that make it a statistic rather
 * than a log.
 *
 * The sibling of /v1/admin/policy/decisions, over a different question.
 * That one answers "who was allowed to see what"; this one answers "why
 * did the engine abstain, escalate or zoom, under which policy version,
 * and what did it cost".
 *
 * Not gated by its own flag: the rows either exist (capture on) or the
 * feed is empty, and an empty feed is the honest answer — a 404 here
 * would only repeat the mistake the rest of this wave undid.
 */
@Controller('v1/admin/memory/decisions')
@UseGuards(ApiKeyGuard)
export class AdminMemoryDecisionsController {
  constructor(private readonly decisions: MemoryDecisionsReadService) {}

  @Get()
  @RequireScopes('brain:admin')
  async feed(
    @Req() req: AuthenticatedRequest,
    @Query()
    q: {
      decisionKind?: string;
      chosenAction?: string;
      policyVersion?: string;
      requestId?: string;
      limit?: string;
      before?: string;
    },
  ): Promise<MemoryDecisionsResponse> {
    const parsedLimit = q.limit ? parseInt(q.limit, 10) : undefined;
    return await this.decisions.feed(req.brainAuth.companyId, {
      ...(q.decisionKind ? { decisionKind: q.decisionKind } : {}),
      ...(q.chosenAction ? { chosenAction: q.chosenAction } : {}),
      ...(q.policyVersion ? { policyVersion: q.policyVersion } : {}),
      ...(q.requestId ? { requestId: q.requestId } : {}),
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      ...(q.before ? { before: q.before } : {}),
    });
  }

  @Get('stats')
  @RequireScopes('brain:admin')
  async stats(
    @Req() req: AuthenticatedRequest,
    @Query('windowDays') windowDays?: string,
  ): Promise<MemoryDecisionsStatsResponse> {
    const days = windowDays ? parseInt(windowDays, 10) : 7;
    return await this.decisions.stats(
      req.brainAuth.companyId,
      Number.isFinite(days) && days > 0 ? days : 7,
    );
  }
}
