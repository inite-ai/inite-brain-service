import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import {
  StrategyMemoryService,
  type StrategyItem,
  type StrategyStatus,
} from './strategy-memory.service';
import {
  StrategyDistillService,
  type DistillStats,
  type PostMortem,
  type TrajectoryCaptureStats,
  type TrajectoryRun,
} from './strategy-distill.service';
import { TRAJECTORY_MAX_STEPS, isVerifiedOutcome, type RawToolStep } from './trajectory-digest';

/**
 * Admin surface of the strategy-memory lane (G4). Operator-invoked,
 * admin-scoped, gated by STRATEGY_MEMORY_ENABLED (default off → 404,
 * indistinguishable from "not deployed" — the EPISODES_API_ENABLED
 * idiom). Deliberately NOT in the platform OpenAPI document: the
 * admin/ops surface is out of scope there by design
 * (scripts/build-openapi.ts).
 *
 *   POST  /v1/admin/strategy/distill    — post-mortem batch → ≤3
 *         dedup-merged candidate items (the eval-harness feed).
 *   POST  /v1/admin/strategy/trajectory — completed tool-run + verified
 *         outcome → one trajectory-bearing candidate item (bet #3,
 *         Part 3). ADDITIONALLY gated by STRATEGY_TRAJECTORIES_ENABLED:
 *         off → 404, indistinguishable from not deployed, no effect.
 *   GET   /v1/admin/strategy            — list (status filter).
 *   PATCH /v1/admin/strategy/:id        — status flip (candidate→active
 *         confirmation, manual deprecation).
 */

const STATUSES: readonly StrategyStatus[] = ['candidate', 'active', 'deprecated'];

const MAX_POST_MORTEMS = 50;

/** Cap on the free-text task/ref fields of a captured trajectory. */
const MAX_TRAJECTORY_TEXT = 2000;

@Controller('v1/admin/strategy')
@UseGuards(ApiKeyGuard)
export class StrategyAdminController {
  constructor(
    private readonly strategies: StrategyMemoryService,
    private readonly distiller: StrategyDistillService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  private assertEnabled(): void {
    if (!this.strategies.isEnabled()) {
      throw new NotFoundException();
    }
  }

  /**
   * Capture is gated by BOTH the master and STRATEGY_TRAJECTORIES_ENABLED:
   * with the extension off the route 404s (no effect → byte-identical to
   * pre-0098), exactly like the whole lane 404s with the master off.
   */
  private assertTrajectoriesEnabled(): void {
    if (!this.strategies.isTrajectoriesEnabled()) {
      throw new NotFoundException();
    }
  }

  private resolveTenant(req: AuthenticatedRequest, tenant?: string): string {
    const resolved = tenant?.trim() || req.brainAuth.companyId;
    if (
      resolved !== req.brainAuth.companyId &&
      !this.apiKeys.knownCompanyIds().includes(resolved)
    ) {
      throw new BadRequestException(`Unknown tenant '${resolved}' — not a registered tenant`);
    }
    return resolved;
  }

  @Post('distill')
  @RequireScopes('brain:admin')
  async distill(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      tenant?: string;
      runId?: string;
      postMortems?: PostMortem[];
    } = {},
  ): Promise<DistillStats> {
    this.assertEnabled();
    const tenant = this.resolveTenant(req, body.tenant);
    const postMortems = body.postMortems;
    if (!Array.isArray(postMortems) || postMortems.length === 0) {
      throw new BadRequestException('postMortems must be a non-empty array');
    }
    if (postMortems.length > MAX_POST_MORTEMS) {
      throw new BadRequestException(`postMortems capped at ${MAX_POST_MORTEMS} per call`);
    }
    for (const [i, pm] of postMortems.entries()) {
      for (const field of ['question', 'goldAnswer', 'ourAnswer', 'diagnosis'] as const) {
        if (typeof pm?.[field] !== 'string' || !pm[field].trim()) {
          throw new BadRequestException(`postMortems[${i}].${field} must be a non-empty string`);
        }
      }
    }
    return this.distiller.distillFromPostMortems(
      tenant,
      postMortems,
      body.runId?.trim() || undefined,
    );
  }

  /**
   * Capture surface for the experience-memory extension (bet #3): a
   * completed tool run + its verified outcome → one trajectory-bearing
   * candidate item, through the SAME dedup-merge as /distill. Raw tool
   * args/results are DIGESTED before storage (no secrets/PII kept
   * verbatim). The trajectory is advice, not evidence — it will only ever
   * reach the generator advisory, never the verifier or citations.
   */
  @Post('trajectory')
  @RequireScopes('brain:admin')
  async trajectory(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      tenant?: string;
      runId?: string;
      task?: string;
      outcome?: string;
      outcomeEvidenceRef?: string;
      steps?: Array<{ tool?: unknown; args?: unknown; result?: unknown; ok?: unknown }>;
    } = {},
  ): Promise<TrajectoryCaptureStats> {
    this.assertEnabled();
    this.assertTrajectoriesEnabled();
    const tenant = this.resolveTenant(req, body.tenant);
    if (typeof body.task !== 'string' || !body.task.trim()) {
      throw new BadRequestException('task must be a non-empty string');
    }
    if (body.task.length > MAX_TRAJECTORY_TEXT) {
      throw new BadRequestException(`task capped at ${MAX_TRAJECTORY_TEXT} chars`);
    }
    if (!isVerifiedOutcome(body.outcome)) {
      throw new BadRequestException('outcome must be one of success/failure/unknown');
    }
    if (
      body.outcomeEvidenceRef !== undefined &&
      (typeof body.outcomeEvidenceRef !== 'string' ||
        body.outcomeEvidenceRef.length > MAX_TRAJECTORY_TEXT)
    ) {
      throw new BadRequestException(
        `outcomeEvidenceRef must be a string ≤ ${MAX_TRAJECTORY_TEXT} chars`,
      );
    }
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BadRequestException('steps must be a non-empty array');
    }
    if (steps.length > TRAJECTORY_MAX_STEPS) {
      throw new BadRequestException(`steps capped at ${TRAJECTORY_MAX_STEPS} per run`);
    }
    const rawSteps: RawToolStep[] = steps.map((s, i) => {
      if (typeof s?.tool !== 'string' || !s.tool.trim()) {
        throw new BadRequestException(`steps[${i}].tool must be a non-empty string`);
      }
      if (typeof s.ok !== 'boolean') {
        throw new BadRequestException(`steps[${i}].ok must be a boolean`);
      }
      // args/result are arbitrary and DIGESTED, not stored raw — passed
      // through untouched here for the digester to hash + redact.
      return { tool: s.tool, args: s.args, result: s.result, ok: s.ok };
    });
    const run: TrajectoryRun = {
      task: body.task,
      outcome: body.outcome,
      steps: rawSteps,
      ...(body.outcomeEvidenceRef ? { outcomeEvidenceRef: body.outcomeEvidenceRef } : {}),
    };
    return this.distiller.distillFromTrajectory(tenant, run, body.runId?.trim() || undefined);
  }

  @Get()
  @RequireScopes('brain:admin')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() q: { tenant?: string; status?: string; limit?: string },
  ): Promise<{ strategies: StrategyItem[] }> {
    this.assertEnabled();
    const resolved = this.resolveTenant(req, q.tenant);
    if (q.status !== undefined && !STATUSES.includes(q.status as StrategyStatus)) {
      throw new BadRequestException(`status must be one of ${STATUSES.join('/')}`);
    }
    const parsedLimit = q.limit !== undefined ? parseInt(q.limit, 10) : undefined;
    if (
      parsedLimit !== undefined &&
      (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
    ) {
      throw new BadRequestException('limit must be 1..200');
    }
    const strategies = await this.strategies.list(resolved, {
      status: q.status as StrategyStatus | undefined,
      limit: parsedLimit,
    });
    return { strategies };
  }

  @Patch(':id')
  @RequireScopes('brain:admin')
  async updateStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { tenant?: string; status?: string } = {},
  ): Promise<StrategyItem> {
    this.assertEnabled();
    const tenant = this.resolveTenant(req, body.tenant);
    if (!STATUSES.includes(body.status as StrategyStatus)) {
      throw new BadRequestException(`status must be one of ${STATUSES.join('/')}`);
    }
    if (!id || id.length > 128) {
      throw new BadRequestException('id must be a strategy record id');
    }
    return this.strategies.updateStatus(tenant, id, body.status as StrategyStatus);
  }
}
