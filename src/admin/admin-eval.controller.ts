import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import {
  ScenarioRunnerService,
  ScenarioRunOutcome,
} from './scenario-runner.service';
import { BaselineService } from './baseline.service';
import { TraceBufferService } from '../common/debug-trace';
import type { ScenariosResponse } from '../contracts/admin/scenarios.schema';
import type { BaselinesResponse } from '../contracts/admin/baselines.schema';
import type { TracesResponse } from '../contracts/admin/traces.schema';
import type { ScenarioDetailResponse } from '../contracts/admin/scenario-detail.schema';
import type { TraceDetailResponse } from '../contracts/admin/trace-detail.schema';

/**
 * Operator-facing eval and observability surface — scenarios, baselines,
 * and request traces. Split out of AdminController to keep each
 * controller scoped to one operator workflow.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminEvalController {
  constructor(
    private readonly scenarios: ScenarioRunnerService,
    private readonly baselines: BaselineService,
    private readonly traces: TraceBufferService,
  ) {}

  // ── Scenarios ────────────────────────────────────────────────────

  @Get('scenarios')
  @RequireScopes('brain:admin')
  listScenarios(@Query('vertical') vertical?: string): ScenariosResponse {
    const all = this.scenarios.list();
    return {
      scenarios: vertical
        ? all.filter((s) => s.vertical === vertical)
        : all,
    } satisfies ScenariosResponse;
  }

  @Get('scenarios/:id')
  @RequireScopes('brain:admin')
  getScenario(@Param('id') id: string): ScenarioDetailResponse {
    // Scenario carries SetupStep / QueryExpectation discriminated unions
    // without an index signature, so direct assignment to the open-record
    // shape needs an unknown bridge. Drift surfaces on the runtime parse
    // at the BFF — the contract is still load-bearing.
    return this.scenarios.getById(id) as unknown as ScenarioDetailResponse;
  }

  @Post('scenarios/:id/run')
  @RequireScopes('brain:admin')
  async runScenario(
    @Param('id') id: string,
    @Body() body: { keepTenant?: boolean },
  ) {
    return this.scenarios.runOne(id, {
      keepTenant: body?.keepTenant === true,
    });
  }

  /**
   * Synchronous batch — capped at BATCH_CAP scenarios per request so a
   * long tail of LLM-bound scenarios can't outrun Traefik / Node respond
   * timeouts. For full-suite runs the operator iterates from the UI;
   * SSE / async-job paths are tracked for a follow-up.
   */
  @Post('scenarios/run-batch')
  @RequireScopes('brain:admin')
  async runBatch(
    @Body()
    body: { ids?: string[]; vertical?: string; keepTenant?: boolean },
  ) {
    const BATCH_CAP = 10;
    const all = this.scenarios.list();
    const candidate = body.ids?.length
      ? body.ids
      : body.vertical
        ? all
            .filter((s) => s.vertical === body.vertical)
            .map((s) => s.id)
        : all.map((s) => s.id);
    if (candidate.length > BATCH_CAP) {
      throw new BadRequestException(
        `Too many scenarios (${candidate.length}). Cap is ${BATCH_CAP} per call — split into multiple requests.`,
      );
    }
    const outcomes: ScenarioRunOutcome[] = [];
    for (const id of candidate) {
      try {
        outcomes.push(
          await this.scenarios.runOne(id, {
            keepTenant: body?.keepTenant === true,
          }),
        );
      } catch (e) {
        outcomes.push({
          scenarioId: id,
          vertical: 'cross',
          companyId: '-',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          passed: false,
          setupSummary: {
            facts: 0,
            mentions: 0,
            links: 0,
            retracts: 0,
            forgets: 0,
            errors: [
              { step: -1, kind: 'runtime', error: (e as Error).message },
            ],
          },
          queryResults: [],
          memoryAssertionResults: [],
          metrics: {
            recallAt1: 0,
            recallAt5: 0,
            queries: 0,
            passes: 0,
            memoryAssertionsPassed: 0,
            memoryAssertionsTotal: 0,
            piiGatingPassed: 0,
            piiGatingTotal: 0,
          },
        });
      }
    }
    return { outcomes };
  }

  // ── Baselines ────────────────────────────────────────────────────

  @Get('baselines')
  @RequireScopes('brain:admin')
  async listBaselines(): Promise<BaselinesResponse> {
    return (await this.baselines.list()) satisfies BaselinesResponse;
  }

  @Post('baselines/:name')
  @RequireScopes('brain:admin')
  async saveBaseline(
    @Param('name') name: string,
    @Body() body: { outcomes: ScenarioRunOutcome[] },
  ) {
    if (!body?.outcomes?.length) {
      throw new BadRequestException(
        'outcomes[] required and must be non-empty',
      );
    }
    return this.baselines.save(name, body.outcomes);
  }

  @Post('baselines/:name/diff')
  @RequireScopes('brain:admin')
  async diffBaseline(
    @Param('name') name: string,
    @Body() body: { outcomes: ScenarioRunOutcome[] },
  ) {
    return this.baselines.diff(name, body?.outcomes ?? []);
  }

  // ── Traces ───────────────────────────────────────────────────────
  //
  // Trace records are scoped to the caller's companyId. The interceptor
  // refuses to write snapshots for non-admin callers in the first place,
  // and the buffer filter here keeps one admin from reading another
  // tenant's artifacts. There is intentionally no super-admin global view.

  @Get('traces')
  @RequireScopes('brain:admin')
  listTraces(@Req() req: AuthenticatedRequest): TracesResponse {
    return {
      traces: this.traces.list(req.brainAuth.companyId),
    } satisfies TracesResponse;
  }

  /**
   * Server-Sent Events stream of NEW trace metadata, scoped to the
   * caller's companyId. Lets the /admin/traces page push-update in
   * real time instead of poll-refreshing every 3s.
   *
   *   GET /v1/admin/traces/stream
   *
   * The stream emits a TraceListItem (no spans / no artifacts) on
   * each accepted snapshot matching the caller. EventSource on the
   * client auto-reconnects on transport hiccup.
   */
  @Sse('traces/stream')
  @RequireScopes('brain:admin')
  streamTraces(
    @Req() req: AuthenticatedRequest,
  ): Observable<{ data: unknown }> {
    const tenant = req.brainAuth.companyId;
    return this.traces.observe().pipe(
      filter((t) => !tenant || t.companyId === tenant),
      map((t) => ({ data: t })),
    );
  }

  @Get('traces/:requestId')
  @RequireScopes('brain:admin')
  async getTrace(
    @Req() req: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ): Promise<TraceDetailResponse> {
    const t = await this.traces.get(requestId, req.brainAuth.companyId);
    if (!t) throw new NotFoundException(`Trace ${requestId} not found`);
    return t satisfies TraceDetailResponse;
  }
}
