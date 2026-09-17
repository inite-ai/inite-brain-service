import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PredicateRegistryService, PredicateDefinition } from '../ai/predicate-registry.service';
import {
  PredicateConsolidationService,
  type ConsolidationResult,
} from './predicate-consolidation.service';
import type { PredicatesListResponse } from '../contracts/admin/predicates.schema';
import type {
  PredicateMutationResponse,
  PredicateDeprecateResponse,
} from '../contracts/admin/write-responses.schema';

/**
 * Operator-facing CRUD for the per-tenant predicate vocabulary. Adding
 * a predicate here makes the extractor admit it on the next call (60s
 * TTL on the snapshot cache, invalidated on every write below). This
 * is how a new vertical onboards without code changes — see the EDC
 * auto-classification path inside the extractor for the LLM-driven side.
 */
@Controller('v1/admin/predicates')
@UseGuards(ApiKeyGuard)
export class AdminPredicatesController {
  constructor(
    private readonly predicateRegistry: PredicateRegistryService,
    private readonly consolidation: PredicateConsolidationService,
  ) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<PredicatesListResponse> {
    const predicates = await this.predicateRegistry.listAll(req.brainAuth.companyId);
    return { predicates } satisfies PredicatesListResponse;
  }

  @Post()
  @RequireScopes('brain:admin')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: Partial<PredicateDefinition> & {
      predicateId: string;
      semantics: 'append_only' | 'single_active' | 'bitemporal';
      piiClass: 'none' | 'identifier' | 'behavioral' | 'text' | 'sensitive';
    },
  ): Promise<PredicateMutationResponse> {
    if (!body?.predicateId?.trim()) {
      throw new BadRequestException('predicateId is required');
    }
    if (!/^[a-z][a-z0-9_]*$/.test(body.predicateId)) {
      throw new BadRequestException(
        'predicateId must be lowercase snake_case (e.g. medical_diagnosis)',
      );
    }
    const created = await this.predicateRegistry.create(req.brainAuth.companyId, body);
    return { predicate: created } satisfies PredicateMutationResponse;
  }

  @Patch(':predicateId')
  @RequireScopes('brain:admin')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body()
    patch: Partial<Omit<PredicateDefinition, 'predicateId' | 'createdBy'>>,
  ): Promise<PredicateMutationResponse> {
    const updated = await this.predicateRegistry.update(
      req.brainAuth.companyId,
      predicateId,
      patch,
    );
    if (!updated) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: updated } satisfies PredicateMutationResponse;
  }

  @Delete(':predicateId')
  @RequireScopes('brain:admin')
  async deprecate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ): Promise<PredicateDeprecateResponse> {
    const ok = await this.predicateRegistry.deprecate(req.brainAuth.companyId, predicateId);
    if (!ok) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { deprecated: predicateId } satisfies PredicateDeprecateResponse;
  }

  @Post(':predicateId/promote')
  @RequireScopes('brain:admin')
  async promote(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ): Promise<PredicateMutationResponse> {
    const result = await this.predicateRegistry.promote(req.brainAuth.companyId, predicateId);
    if (!result) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: result } satisfies PredicateMutationResponse;
  }

  @Post(':predicateId/alias')
  @RequireScopes('brain:admin')
  async alias(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body() body: { canonicalId: string },
  ): Promise<PredicateMutationResponse> {
    if (!body?.canonicalId?.trim()) {
      throw new BadRequestException('canonicalId is required');
    }
    const { def } = await this.predicateRegistry.alias(
      req.brainAuth.companyId,
      predicateId,
      body.canonicalId,
    );
    if (!def) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: def } satisfies PredicateMutationResponse;
  }

  /**
   * Fold the tenant's accumulated vocabulary onto its canonical names —
   * the pass that replaced a per-coinage decision.
   *
   * Deciding "is this coinage a rename of one we already have" at write
   * time is order-dependent, retroactively blind and local: it sees three
   * candidates, never the vocabulary, and never revisits an answer. This
   * runs over the whole registry, reconsiders what is already stored, and
   * carries each merge onto the facts written under the old name.
   *
   * `dryRun` reports the merges it would make and writes nothing — the
   * intended way to look before consolidating a live tenant.
   */
  @Post('consolidate')
  @RequireScopes('brain:admin')
  async consolidate(
    @Req() req: AuthenticatedRequest,
    @Body() body: { dryRun?: boolean } = {},
  ): Promise<ConsolidationResult> {
    return this.consolidation.run(req.brainAuth.companyId, {
      dryRun: body?.dryRun === true,
    });
  }
}
