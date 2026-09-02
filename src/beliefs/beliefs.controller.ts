import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { envFlagEnabled } from '../common/env-validation';
import { AuthenticatedRequest } from '../auth/api-key.types';
import {
  BELIEF_STATUS_FILTERS,
  BELIEFS_LIST_DEFAULT,
  BELIEFS_LIST_MAX,
  BeliefsService,
  type BeliefReadResult,
  type BeliefsListResult,
  type BeliefStatusFilter,
} from './beliefs.service';

/**
 * Belief read API (Belief-B): the semantic_belief substrate (migration
 * 0120) as a read-only contract — what the brain currently HOLDS about a
 * free-text (subject, field) key, with its supersede chain and inline
 * scene provenance. Read-only by design: the ONLY writer stays the
 * Belief-A promotion pass; GDPR erasure runs through the forget
 * cascades, so no retract verb exists here (unlike /v1/facts).
 *
 * Deliberately minimal v1 surface:
 *  - NO provenance endpoint yet — a get_fact_provenance-style walk
 *    (sourceSceneIds -> scene members -> verbatim turns through the
 *    PII-fenced episode read port) is future work;
 *  - NO memory_support edge exposure (supportEdges stays internal);
 *  - NO MCP twins yet — surface parity with the fact read tools is a
 *    follow-up PR.
 */

interface BeliefListQuery {
  /** Free-text subject key (exact match). */
  subject?: string;
  /** Free-text field key (exact match). */
  field?: string;
  /** End-user scope key — M2M may assert any; user-bound tokens are
   *  pinned to their own user (mismatch = 403). */
  userId?: string;
  /** Lifecycle filter: active (default) | superseded | all. */
  status?: string;
  limit?: string;
}

@Controller('v1/beliefs')
@UseGuards(ApiKeyGuard)
export class BeliefsController {
  constructor(private readonly beliefs: BeliefsService) {}

  /**
   * Read-surface gate (BELIEFS_API_ENABLED, default off → 404 —
   * indistinguishable from an absent route; the FACTS_API_ENABLED /
   * EPISODES_API_ENABLED idiom). Read at call time so a flip is
   * runtime-mutable.
   */
  private assertEnabled(): void {
    if (!envFlagEnabled(process.env.BELIEFS_API_ENABLED)) {
      throw new NotFoundException();
    }
  }

  /** List beliefs by the free-text (subject, field) key, page-capped. */
  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('list_beliefs')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: BeliefListQuery,
  ): Promise<BeliefsListResult> {
    this.assertEnabled();
    const limitRaw = q.limit !== undefined ? parseInt(q.limit, 10) : BELIEFS_LIST_DEFAULT;
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      throw new BadRequestException(`limit must be 1..${BELIEFS_LIST_MAX}`);
    }
    const status = q.status ?? 'active';
    if (!(BELIEF_STATUS_FILTERS as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of ${BELIEF_STATUS_FILTERS.join(', ')}`);
    }
    return this.beliefs.listBeliefs({
      companyId: req.brainAuth.companyId,
      scopes: req.brainAuth.scopes,
      subject: q.subject,
      field: q.field,
      userId: q.userId,
      status: status as BeliefStatusFilter,
      limit: Math.min(limitRaw, BELIEFS_LIST_MAX),
    });
  }

  /** One belief revision — "what do you currently hold, and since when". */
  @Get(':id')
  @RequireScopes('brain:read')
  @PolicyAction('get_belief')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<BeliefReadResult> {
    this.assertEnabled();
    return this.beliefs.getBelief({
      companyId: req.brainAuth.companyId,
      beliefId: id,
      scopes: req.brainAuth.scopes,
    });
  }
}
