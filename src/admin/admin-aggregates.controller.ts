import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import { AggregateComposerService, AggregateRunResult } from './aggregate-composer.service';
import { ArcComposerService, ArcRunResult } from './arc-composer.service';
import { parseBatchKeys } from '../common/batch-outcome';

/** Retry-selector belt: the composers' own entity cap, as record ids. */
const KEYS_MAX = 50;
const ENTITY_ID_MAX_CHARS = 256;

interface ComposerBody {
  tenant?: string;
  entities?: number;
  version?: string;
  /** Retry selector: `outcome.failed[].key` (knowledge_entity ids) of a previous run. */
  keys?: string[];
}

/**
 * Explicit triggers for the write-time insight composers (each costs one
 * LLM call per composed entity). Synchronous like the HNSW maintenance
 * trigger: the operator wants the counts before relying on the rows in
 * retrieval. Re-runs replace the previous set wholesale
 * (delete-by-recorder), so both endpoints are idempotent.
 *
 * - maintenance/aggregates — Lane C aspect aggregates (attribute
 *   rollups; enumeration pre-answers).
 * - maintenance/arcs — V9 §3 topic arcs (dated chronological
 *   narratives; the progressive-summary shape the aggregates lack).
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminAggregatesController {
  constructor(
    private readonly composer: AggregateComposerService,
    private readonly arcs: ArcComposerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('maintenance/aggregates')
  @RequireScopes('brain:admin')
  async run(
    @Req() req: AuthenticatedRequest,
    @Body() body: ComposerBody = {},
  ): Promise<AggregateRunResult> {
    const { tenant, version, entityIds } = this.validate(req, body);
    return this.composer.run(tenant, { entities: body.entities, version, entityIds });
  }

  @Post('maintenance/arcs')
  @RequireScopes('brain:admin')
  async runArcs(
    @Req() req: AuthenticatedRequest,
    @Body() body: ComposerBody = {},
  ): Promise<ArcRunResult> {
    const { tenant, version, entityIds } = this.validate(req, body);
    return this.arcs.run(tenant, { entities: body.entities, version, entityIds });
  }

  private validate(
    req: AuthenticatedRequest,
    body: ComposerBody,
  ): { tenant: string; version?: string | undefined; entityIds?: string[] | undefined } {
    const tenant = resolvePlatformTenant(req, body.tenant, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
    const version = body.version?.trim() || undefined;
    if (version && !/^[a-z0-9-]{2,32}$/.test(version)) {
      throw new BadRequestException('version must be a short kebab-case tag (e.g. wd-v2)');
    }
    const entityIds = parseBatchKeys(body.keys, {
      maxKeys: KEYS_MAX,
      maxLength: ENTITY_ID_MAX_CHARS,
      accept: (key) => key.startsWith('knowledge_entity:'),
    });
    return { tenant, version, entityIds };
  }
}
