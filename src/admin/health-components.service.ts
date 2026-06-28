import { Injectable } from '@nestjs/common';
import { EmbedderService } from '../ai/embedder.service';
import { IntentClassifierService } from './intent-classifier.service';
import { ChangefeedConsumerService } from '../audit/changefeed-consumer.service';
import type { HealthComponentsResponse } from '../contracts/admin/health-components.schema';

type ComponentStatus =
  | 'ok'
  | 'warming'
  | 'degraded'
  | 'disabled'
  | 'unreachable';

/**
 * HealthComponentsService — builds the per-component health grid for the
 * admin cockpit (/v1/admin/health/components). Probes the embedder,
 * intent classifier, and changefeed consumer; the DB-liveness result is
 * passed in by the controller (which owns AdminInfraService.pingDb).
 * Extracted from AdminInfraController so the controller keeps ≤3 deps and
 * holds no business logic.
 */
@Injectable()
export class HealthComponentsService {
  constructor(
    private readonly embedder: EmbedderService,
    private readonly intent: IntentClassifierService,
    private readonly changefeed: ChangefeedConsumerService,
  ) {}

  build(dbOk: boolean, dbLatencyMs: number): HealthComponentsResponse {
    const components: Array<{
      name: string;
      status: ComponentStatus;
      latencyMs?: number;
      message?: string;
    }> = [];

    // SurrealDB (probed by the caller)
    components.push({
      name: 'surrealdb',
      status: dbOk ? 'ok' : 'unreachable',
      latencyMs: dbLatencyMs,
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
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    components.push({
      name: 'openai key',
      status: hasOpenAI ? 'ok' : 'disabled',
      message: hasOpenAI ? 'present (not pinged)' : 'OPENAI_API_KEY unset',
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
        (process.env.CALIBRATION_USE_GOLD_SET ?? '1') === '0'
          ? 'disabled'
          : 'ok',
      message: 'see /admin/calibration for ECE + version history',
    });

    return {
      generatedAt: new Date().toISOString(),
      components,
    } satisfies HealthComponentsResponse;
  }
}
