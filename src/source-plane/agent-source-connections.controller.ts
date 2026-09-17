import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import {
  AGENT_HOST,
  AgentDeltasRequestSchema,
  BeginAgentRunRequestSchema,
  FetchedItemWireSchema,
  FinishAgentRunRequestSchema,
  isConnectionId,
  type AgentConnectionsListResponse,
  type AgentDeltasResponse,
  type AgentItemResponse,
  type BeginAgentRunResponse,
  type SourceSyncSummary,
} from '../contracts/source-plane/source-plane.schema';
import { AgentRunService } from './agent-run.service';
import { z } from 'zod';

/**
 * The agent protocol (brain:write) — the wire the local agent speaks
 * (docs/source-plane.md § Agent). Mounted beside the admin surface
 * (`/v1/admin/source-connections`) on its own root: an agent key is a
 * tenant WRITE key, never an admin one, and it only ever reaches the
 * connections an operator pointed at its host (`host: agent:<id>`).
 *
 *   GET  /v1/source-connections?host=agent:<id>       the agent's connections + pack entries
 *   POST /v1/source-connections/:id/agent-runs         begin ⇒ { runId, full, checkpoint, … }
 *   POST …/agent-runs/:runId/deltas                    a batch of upsert / gone / checkpoint ⇒ what to fetch
 *   POST …/agent-runs/:runId/items                     one fetched item's content ⇒ its outcome
 *   POST …/agent-runs/:runId/finish                    ⇒ the run summary
 *
 * Bare 404 while SOURCE_PLANE_ENABLED is off, exactly like the admin surface.
 */
@Controller('v1/source-connections')
@UseGuards(ApiKeyGuard)
export class AgentSourceConnectionsController {
  constructor(private readonly runs: AgentRunService) {}

  @Get()
  @RequireScopes('brain:write')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('host') host?: string,
  ): Promise<AgentConnectionsListResponse> {
    if (typeof host !== 'string' || !AGENT_HOST.test(host)) {
      throw new BadRequestException('host=agent:<id> is required');
    }
    return this.runs.listForHost(req.brainAuth.companyId, host);
  }

  @Post(':id/agent-runs')
  @RequireScopes('brain:write')
  async begin(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BeginAgentRunResponse> {
    return this.runs.begin(
      req.brainAuth.companyId,
      assertId(id),
      parseBody(BeginAgentRunRequestSchema, body ?? {}),
    );
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Body binding, cannot be folded into an options object without breaking Nest param resolution
  @Post(':id/agent-runs/:runId/deltas')
  @RequireScopes('brain:write')
  async deltas(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<AgentDeltasResponse> {
    const { deltas } = parseBody(AgentDeltasRequestSchema, body);
    return this.runs.deltas(req.brainAuth.companyId, {
      connectionId: assertId(id),
      runId: assertRunId(runId),
      deltas,
    });
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Body binding, cannot be folded into an options object without breaking Nest param resolution
  @Post(':id/agent-runs/:runId/items')
  @RequireScopes('brain:write')
  async item(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<AgentItemResponse> {
    const { externalId, item } = parseBody(ItemEnvelopeSchema, body);
    const out = await this.runs.item(req.brainAuth.companyId, {
      connectionId: assertId(id),
      runId: assertRunId(runId),
      externalId,
      item,
    });
    return out.error === undefined
      ? { status: out.status }
      : { status: out.status, error: out.error };
  }

  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Body binding, cannot be folded into an options object without breaking Nest param resolution
  @Post(':id/agent-runs/:runId/finish')
  @RequireScopes('brain:write')
  async finish(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<SourceSyncSummary> {
    return this.runs.finish(req.brainAuth.companyId, {
      connectionId: assertId(id),
      runId: assertRunId(runId),
      req: parseBody(FinishAgentRunRequestSchema, body ?? {}),
    });
  }
}

const ItemEnvelopeSchema = z.object({
  externalId: z.string().min(1).max(2048),
  item: FetchedItemWireSchema,
});

const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new BadRequestException('invalid run id');
  return runId;
}

function assertId(id: string): string {
  const full = id.startsWith('source_connection:') ? id : `source_connection:${id}`;
  if (!isConnectionId(full)) throw new BadRequestException('invalid connection id');
  return full;
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
