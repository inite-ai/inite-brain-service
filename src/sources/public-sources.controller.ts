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
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { SourcesService } from './sources.service';
import {
  SOURCE_TYPES,
  type PublicSourceDetailResponse,
  type PublicSourcesListResponse,
  type SourceType,
} from '../contracts/sources/sources.schema';
import {
  filterAndPage,
  PUBLIC_LIST_MAX_LIMIT,
  toPublicDetail,
  type PublicListFilter,
} from './public-projection';

/**
 * Read-only trust-inputs surface for ordinary brain:read callers
 * (trust-inputs track). Same data the brain:admin /v1/admin/sources
 * routes serve, through the public projection: declared type/authLevel
 * ⋈ learned reputation, WITHOUT the operator annotations (owner/note)
 * and with the history trail capped at PUBLIC_HISTORY_LIMIT. Detail
 * reuses the `get_source_reputation` ABAC action (house rule: REST
 * reuses the equivalent MCP tool name); list is REST-only.
 */
@Controller('v1/sources')
@UseGuards(ApiKeyGuard)
export class PublicSourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  @RequireScopes('brain:read')
  @PolicyAction('rest.sources.list')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query()
    query: {
      domain?: string;
      type?: string;
      minSamples?: string;
      limit?: string;
      offset?: string;
    },
  ): Promise<PublicSourcesListResponse> {
    const filter = parseListQuery(query);
    const summaries = await this.sources.list(req.brainAuth.companyId, {
      domain: filter.domain,
    });
    const { items, total } = filterAndPage(summaries, filter);
    return {
      sources: items,
      total,
      limit: filter.limit,
      offset: filter.offset,
    } satisfies PublicSourcesListResponse;
  }

  @Get(':sourceKey')
  @RequireScopes('brain:read')
  @PolicyAction('get_source_reputation')
  async detail(
    @Req() req: AuthenticatedRequest,
    @Param('sourceKey') sourceKey: string,
  ): Promise<PublicSourceDetailResponse> {
    const detail = await this.sources.detail(
      req.brainAuth.companyId,
      sourceKey,
    );
    // The admin detail never 404s (it answers empty shells); the public
    // surface should not leak "known vs unknown" ambiguity — a source
    // with neither a declared row nor learned trust does not exist.
    if (!detail.declared && detail.trust.length === 0) {
      throw new NotFoundException(`unknown source '${sourceKey}'`);
    }
    return toPublicDetail(detail);
  }
}

function parseListQuery(query: {
  domain?: string;
  type?: string;
  minSamples?: string;
  limit?: string;
  offset?: string;
}): PublicListFilter {
  if (
    query.type !== undefined &&
    !SOURCE_TYPES.includes(query.type as SourceType)
  ) {
    throw new BadRequestException(
      `type must be one of ${SOURCE_TYPES.join('|')}`,
    );
  }
  return {
    ...(query.domain !== undefined ? { domain: query.domain } : {}),
    ...(query.type !== undefined ? { type: query.type as SourceType } : {}),
    ...(query.minSamples !== undefined
      ? { minSamples: parseIntStrict('minSamples', query.minSamples, 0) }
      : {}),
    limit: Math.min(
      query.limit !== undefined ? parseIntStrict('limit', query.limit, 1) : 50,
      PUBLIC_LIST_MAX_LIMIT,
    ),
    offset:
      query.offset !== undefined
        ? parseIntStrict('offset', query.offset, 0)
        : 0,
  };
}

/** Strict base-10 parse — garbage is a 400, not a silent default. */
function parseIntStrict(name: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new BadRequestException(`${name} must be an integer >= ${min}`);
  }
  return n;
}
