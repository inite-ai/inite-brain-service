import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AdminInfraService } from './admin-infra.service';
import { EmbedderService } from '../ai/embedder.service';
import { IntentClassifierService } from './intent-classifier.service';
import { ChangefeedConsumerService } from '../audit/changefeed-consumer.service';
import { ActivityTrackerService } from '../common/activity-tracker.service';
import { ThrottlerObservabilityService } from './throttler-observability.service';
import type { HealthComponentsResponse } from '../contracts/admin/health-components.schema';
import type { MigrationsResponse } from '../contracts/admin/migrations.schema';
import type { ThrottlerResponse } from '../contracts/admin/throttler.schema';
import type { NowResponse } from '../contracts/admin/now.schema';

/**
 * Infra cockpit — deeper than /health. Per-component status grid,
 * migrations applied per tenant + drift detection, throttler
 * observability, in-flight HTTP requests.
 *
 *   /v1/admin/health/components — per-component grid for the sidebar
 *   /v1/admin/migrations        — applied vs pending per tenant
 *   /v1/admin/throttler         — top routes / actors / recent 429s
 *   /v1/admin/now               — currently in-flight HTTP requests
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminInfraController {
  constructor(
    private readonly adminInfra: AdminInfraService,
    private readonly embedder: EmbedderService,
    private readonly intent: IntentClassifierService,
    private readonly changefeed: ChangefeedConsumerService,
    private readonly activity: ActivityTrackerService,
    private readonly throttler: ThrottlerObservabilityService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Per-component health grid. Each component reports status (ok |
   * warming | degraded | disabled | unreachable) + latency (when
   * cheap) + a short message. Distinct from /health which is the
   * binary up/down for k8s.
   */
  @Get('health/components')
  @RequireScopes('brain:admin')
  async healthComponents(): Promise<HealthComponentsResponse> {
    const components: Array<{
      name: string;
      status: 'ok' | 'warming' | 'degraded' | 'disabled' | 'unreachable';
      latencyMs?: number;
      message?: string;
    }> = [];

    // SurrealDB
    const dbStart = Date.now();
    const dbOk = await this.adminInfra.pingDb();
    components.push({
      name: 'surrealdb',
      status: dbOk ? 'ok' : 'unreachable',
      latencyMs: Date.now() - dbStart,
    });

    // Embedder (BGE-M3 or OpenAI proxy — service exposes isReady)
    const embedderReady = this.embedder.isReady();
    const embedderProvider = this.embedder.cacheStats().provider;
    components.push({
      name: `embedder (${embedderProvider})`,
      status: embedderReady ? 'ok' : 'warming',
      message: embedderReady
        ? `cache size ${this.embedder.cacheStats().size}`
        : 'downloading model weights',
    });

    // Intent classifier
    const intentStats = this.intent.stats();
    components.push({
      name: 'intent classifier',
      status: !intentStats.enabled
        ? 'disabled'
        : intentStats.ready
          ? 'ok'
          : 'warming',
      message: intentStats.enabled
        ? `model=${intentStats.model} cache=${intentStats.cacheSize}`
        : 'CHAT_ROUTE_NLI_ENABLED=0',
    });

    // OpenAI key presence (we don't ping — that would burn tokens)
    const hasOpenAI = !!this.config.get<string>('OPENAI_API_KEY');
    components.push({
      name: 'openai key',
      status: hasOpenAI ? 'ok' : 'disabled',
      message: hasOpenAI
        ? 'present (not pinged)'
        : 'OPENAI_API_KEY unset',
    });

    // Changefeed consumer
    const cf = this.changefeed.stats();
    components.push({
      name: 'changefeed consumer',
      status: !cf.enabled
        ? 'disabled'
        : cf.lastError
          ? 'degraded'
          : cf.lastPendingRemaining > 100
            ? 'degraded'
            : 'ok',
      message: cf.enabled
        ? `${cf.lastPendingRemaining} pending · ${cf.tickCount} ticks`
        : 'AUDIT_CHANGEFEED_ENABLED=0',
    });

    // Calibration source
    components.push({
      name: 'calibration',
      status:
        this.config.get<string>('CALIBRATION_USE_GOLD_SET', '1') === '0'
          ? 'disabled'
          : 'ok',
      message: 'see /admin/calibration for ECE + version history',
    });

    return {
      generatedAt: new Date().toISOString(),
      components,
    } satisfies HealthComponentsResponse;
  }

  /**
   * Per-tenant migration audit. Lists every migration in the manifest
   * + which tenants have applied each one. Highlights drift (tenants
   * missing migrations the others have).
   */
  @Get('migrations')
  @RequireScopes('brain:admin')
  async migrations(): Promise<MigrationsResponse> {
    return this.adminInfra.migrationsAudit();
  }

  @Get('throttler')
  @RequireScopes('brain:admin')
  throttlerView(): ThrottlerResponse {
    return this.throttler.snapshot() satisfies ThrottlerResponse;
  }

  @Get('now')
  @RequireScopes('brain:admin')
  now(): NowResponse {
    return {
      generatedAt: new Date().toISOString(),
      inFlight: this.activity.list(),
    } satisfies NowResponse;
  }
}
