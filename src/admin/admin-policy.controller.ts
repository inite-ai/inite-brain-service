import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PolicyKeysService } from '../policy/policy-keys.service';
import { PolicyRegistryService } from '../policy/policy-registry.service';
import {
  PolicySimulationService,
  SimulationSubject,
} from '../policy/policy-simulation.service';
import type {
  PolicyRegistryResponse,
  PreviewRuleResponse,
  SimulateActionsResponse,
  SimulateSearchResponse,
} from '../contracts/admin/policy-tools.schema';

interface SubjectBody {
  subject?: {
    keyId?: string;
    policyNames?: string[];
    inline?: unknown;
    modeOverride?: 'enforce';
  };
}

/**
 * ABAC tooling surface behind the policy editor + Key Lens UI: the
 * action/attribute registry (single source of truth for every picker),
 * full-pipeline search simulation with per-row verdicts, whole-registry
 * action simulation, and the approximate rule match-count preview.
 */
@Controller('v1/admin/policy')
@UseGuards(ApiKeyGuard)
export class AdminPolicyController {
  constructor(
    private readonly registryService: PolicyRegistryService,
    private readonly simulation: PolicySimulationService,
    private readonly keys: PolicyKeysService,
  ) {}

  @Get('registry')
  @RequireScopes('brain:admin')
  async registry(
    @Req() req: AuthenticatedRequest,
  ): Promise<PolicyRegistryResponse> {
    return (await this.registryService.registry(
      req.brainAuth.companyId,
    )) satisfies PolicyRegistryResponse;
  }

  // Runs the real retrieval pipeline (embedding + optional rerank) —
  // same expensive bucket as /v1/search.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  @Post('simulate/search')
  @RequireScopes('brain:admin')
  async simulateSearch(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: SubjectBody & { query?: { query?: string; limit?: number; asOf?: string } },
  ): Promise<SimulateSearchResponse> {
    if (!body?.query?.query?.trim()) {
      throw new BadRequestException('query.query is required');
    }
    const ctx = await this.resolveSubject(req, body);
    return (await this.simulation.simulateSearch({
      companyId: req.brainAuth.companyId,
      ctx,
      callerScopes: req.brainAuth.scopes,
      query: {
        query: body.query.query,
        ...(body.query.limit !== undefined ? { limit: body.query.limit } : {}),
        ...(body.query.asOf !== undefined ? { asOf: body.query.asOf } : {}),
      },
    })) satisfies SimulateSearchResponse;
  }

  @Post('simulate/actions')
  @RequireScopes('brain:admin')
  async simulateActions(
    @Req() req: AuthenticatedRequest,
    @Body() body: SubjectBody,
  ): Promise<SimulateActionsResponse> {
    const ctx = await this.resolveSubject(req, body);
    return this.simulation.simulateActions(ctx) satisfies SimulateActionsResponse;
  }

  @Post('preview-rule')
  @RequireScopes('brain:admin')
  async previewRule(
    @Req() req: AuthenticatedRequest,
    @Body() body: { rule?: unknown },
  ): Promise<PreviewRuleResponse> {
    if (!body?.rule) {
      throw new BadRequestException('rule is required');
    }
    return (await this.simulation.previewRule(
      req.brainAuth.companyId,
      body.rule,
    )) satisfies PreviewRuleResponse;
  }

  /** keyId → policyNames, then hand the normalized subject to the engine. */
  private async resolveSubject(
    req: AuthenticatedRequest,
    body: SubjectBody,
  ) {
    const subject = body?.subject;
    if (!subject || (!subject.keyId && !subject.policyNames && !subject.inline)) {
      throw new BadRequestException(
        'subject requires one of keyId, policyNames, or inline',
      );
    }
    const normalized: SimulationSubject = {
      ...(subject.policyNames ? { policyNames: subject.policyNames } : {}),
      ...(subject.inline !== undefined ? { inline: subject.inline } : {}),
      ...(subject.modeOverride === 'enforce' ? { modeOverride: 'enforce' as const } : {}),
    };
    if (subject.keyId) {
      const { policyNames } = await this.keys.policyNamesForKeyId(
        req.brainAuth.companyId,
        String(subject.keyId),
      );
      if (policyNames.length === 0) {
        throw new BadRequestException(
          `Key '${subject.keyId}' has no policy sets attached — nothing to simulate`,
        );
      }
      normalized.policyNames = [
        ...new Set([...(normalized.policyNames ?? []), ...policyNames]),
      ];
    }
    return this.simulation.resolveSubject(req.brainAuth.companyId, normalized);
  }
}
