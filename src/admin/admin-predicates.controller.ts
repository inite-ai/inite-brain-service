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
import {
  PredicateRegistryService,
  PredicateDefinition,
} from '../ai/predicate-registry.service';

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
  ) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest) {
    const predicates = await this.predicateRegistry.listAll(
      req.brainAuth.companyId,
    );
    return { predicates };
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
  ) {
    if (!body?.predicateId?.trim()) {
      throw new BadRequestException('predicateId is required');
    }
    if (!/^[a-z][a-z0-9_]*$/.test(body.predicateId)) {
      throw new BadRequestException(
        'predicateId must be lowercase snake_case (e.g. medical_diagnosis)',
      );
    }
    const created = await this.predicateRegistry.create(
      req.brainAuth.companyId,
      body,
    );
    return { predicate: created };
  }

  @Patch(':predicateId')
  @RequireScopes('brain:admin')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body()
    patch: Partial<Omit<PredicateDefinition, 'predicateId' | 'createdBy'>>,
  ) {
    const updated = await this.predicateRegistry.update(
      req.brainAuth.companyId,
      predicateId,
      patch,
    );
    if (!updated) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: updated };
  }

  @Delete(':predicateId')
  @RequireScopes('brain:admin')
  async deprecate(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ) {
    const ok = await this.predicateRegistry.deprecate(
      req.brainAuth.companyId,
      predicateId,
    );
    if (!ok) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { deprecated: predicateId };
  }

  @Post(':predicateId/promote')
  @RequireScopes('brain:admin')
  async promote(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
  ) {
    const result = await this.predicateRegistry.promote(
      req.brainAuth.companyId,
      predicateId,
    );
    if (!result) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: result };
  }

  @Post(':predicateId/alias')
  @RequireScopes('brain:admin')
  async alias(
    @Req() req: AuthenticatedRequest,
    @Param('predicateId') predicateId: string,
    @Body() body: { canonicalId: string },
  ) {
    if (!body?.canonicalId?.trim()) {
      throw new BadRequestException('canonicalId is required');
    }
    const result = await this.predicateRegistry.alias(
      req.brainAuth.companyId,
      predicateId,
      body.canonicalId,
    );
    if (!result) {
      throw new NotFoundException(`Predicate ${predicateId} not found`);
    }
    return { predicate: result };
  }
}
