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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { sourcePlaneEnabled } from '../common/source-plane-flags';
import {
  CreateSourceConnectionRequestSchema,
  SyncNowRequestSchema,
  UpdateSourceConnectionRequestSchema,
  isConnectionId,
  type SourceCatalogResponse,
  type SourceConnection,
  type SourceConnectionsListResponse,
  type SourceItemsListResponse,
  type SyncNowResponse,
} from '../contracts/source-plane/source-plane.schema';
import { SourceCatalogService } from './source-catalog.service';
import { SourceConnectionService } from './source-connection.service';
import { SourceItemService } from './source-item.service';
import { SourceSyncQueueService } from './source-sync-queue.service';
import { SourceSyncService } from './source-sync.service';

/**
 * Operator surface of the source plane (brain:admin). Mounted at its own
 * root rather than under /v1/admin/sources: that controller's
 * `GET :sourceKey` would swallow `/connections` as a source key (the
 * route-order class of the horizontal-scaling wave's SSE 404).
 *
 * Every route answers a bare 404 while SOURCE_PLANE_ENABLED is off —
 * the surface does not exist, rather than "broken".
 */
@Controller('v1/admin/source-connections')
@UseGuards(ApiKeyGuard)
export class AdminSourceConnectionsController {
  // eslint-disable-next-line max-params
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly items: SourceItemService,
    private readonly sync: SourceSyncService,
    private readonly queue: SourceSyncQueueService,
    private readonly catalog: SourceCatalogService,
  ) {}

  @Get()
  @RequireScopes('brain:admin')
  async list(@Req() req: AuthenticatedRequest): Promise<SourceConnectionsListResponse> {
    assertEnabled();
    return { connections: await this.connections.list(req.brainAuth.companyId) };
  }

  @Post()
  @RequireScopes('brain:admin')
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<SourceConnection> {
    assertEnabled();
    return this.connections.create(
      req.brainAuth.companyId,
      parseBody(CreateSourceConnectionRequestSchema, body),
    );
  }

  /** Declared before `:id` — a literal segment must not read as an id. */
  @Get('catalog')
  @RequireScopes('brain:admin')
  async listCatalog(@Req() req: AuthenticatedRequest): Promise<SourceCatalogResponse> {
    assertEnabled();
    return this.catalog.catalog(req.brainAuth.companyId);
  }

  @Get(':id')
  @RequireScopes('brain:admin')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<SourceConnection> {
    assertEnabled();
    return this.connections.get(req.brainAuth.companyId, assertId(id));
  }

  @Patch(':id')
  @RequireScopes('brain:admin')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SourceConnection> {
    assertEnabled();
    return this.connections.update(
      req.brainAuth.companyId,
      assertId(id),
      parseBody(UpdateSourceConnectionRequestSchema, body),
    );
  }

  @Delete(':id')
  @RequireScopes('brain:admin')
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ deleted: true; items: number }> {
    assertEnabled();
    const { items } = await this.connections.remove(req.brainAuth.companyId, assertId(id));
    return { deleted: true, items };
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Query binding, cannot be folded into an options object without breaking Nest param resolution
  @Get(':id/items')
  @RequireScopes('brain:admin')
  async listItems(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<SourceItemsListResponse> {
    assertEnabled();
    const lim = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 500);
    const off = Math.max(Number(offset ?? 0) || 0, 0);
    const st = state === undefined ? undefined : parseState(state);
    const { items, total } = await this.items.list(req.brainAuth.companyId, {
      connectionId: assertId(id),
      state: st,
      limit: lim,
      offset: off,
    });
    return { items, total, limit: lim, offset: off };
  }

  /**
   * Sync now: enqueue a job (default) or run inline and return the
   * summary — inline is for operators watching a first sync, the
   * queue is for everything else.
   */
  @Post(':id/sync')
  @RequireScopes('brain:admin')
  async syncNow(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SyncNowResponse> {
    assertEnabled();
    const dto = parseBody(SyncNowRequestSchema, body ?? {});
    const connectionId = assertId(id);
    // Existence + tenancy check before anything is enqueued.
    await this.connections.get(req.brainAuth.companyId, connectionId);
    if (dto.inline === true) {
      const summary = await this.sync.sync(req.brainAuth.companyId, connectionId, { full: dto.full });
      return { enqueued: false, summary };
    }
    const r = await this.queue.enqueue(req.brainAuth.companyId, {
      connectionId,
      full: dto.full,
      triggeredBy: 'manual',
    });
    if (!r) {
      const summary = await this.sync.sync(req.brainAuth.companyId, connectionId, { full: dto.full });
      return { enqueued: false, summary };
    }
    return { enqueued: true, runId: r.runId, created: r.created };
  }
}

function assertEnabled(): void {
  if (!sourcePlaneEnabled()) throw new NotFoundException();
}

function assertId(id: string): string {
  const full = id.startsWith('source_connection:') ? id : `source_connection:${id}`;
  if (!isConnectionId(full)) throw new BadRequestException('invalid connection id');
  return full;
}

function parseState(v: string): 'seen' | 'fetched' | 'indexed' | 'gone' {
  if (v === 'seen' || v === 'fetched' || v === 'indexed' || v === 'gone') return v;
  throw new BadRequestException('state must be one of seen|fetched|indexed|gone');
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      error: 'validation_failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
