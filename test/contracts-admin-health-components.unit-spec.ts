/**
 * Wire-contract drift guard for GET /v1/admin/health/components.
 */
import { HealthComponentsResponseSchema } from '../src/contracts/admin/health-components.schema';
import { makeAdminInfraController } from './helpers/admin-controllers';
import type { AdminInfraController } from '../src/admin/admin-infra.controller';
import { AdminInfraService } from '../src/admin/admin-infra.service';
import { HealthComponentsService } from '../src/admin/health-components.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { HealthService } from '../src/common/health.service';
import type { CapabilityProbeService } from '../src/metrics/capability-probe.service';
import type { IntentClassifierService } from '../src/admin/intent-classifier.service';
import type { ChangefeedConsumerService } from '../src/audit/changefeed-consumer.service';

function makeController(): AdminInfraController {
  const surreal = {
    ping: async () => true,
  } as unknown as SurrealService;
  const embedder = {
    cacheStats: () => ({ provider: 'bge-m3', size: 100 }),
  } as unknown as EmbedderService;
  const health = {
    readiness: async () => ({
      dbOk: true,
      scopedOk: true,
      embedderReady: true,
      evidenceStoreOk: true,
      ready: true,
      detail: {
        dbLatencyMs: 1,
        scopedEnabled: true,
        scopedLatencyMs: 2,
        embedder: { ready: true, failures: 0, inFlight: false },
        evidenceStore: { scheme: 'fs', probed: false, latencyMs: 0, error: null },
      },
    }),
  } as unknown as HealthService;
  const probe = {
    lastReports: () => ({
      scoped_read: { capability: 'scoped_read', outcome: 'serving', at: new Date().toISOString() },
      embed: { capability: 'embed', outcome: 'serving', at: new Date().toISOString() },
    }),
  } as unknown as CapabilityProbeService;
  const intent = {
    stats: () => ({ enabled: true, ready: true, model: 'mini', cacheSize: 0 }),
  } as unknown as IntentClassifierService;
  const changefeed = {
    stats: () => ({
      enabled: true,
      inFlight: false,
      lastTickAt: null,
      lastPendingRemaining: 0,
      totalConsumed: 0,
      tickCount: 0,
      lastError: null,
      sources: [] as readonly string[],
      perBatchLimit: 100,
    }),
  } as unknown as ChangefeedConsumerService;
  const adminInfra = new AdminInfraService(surreal, undefined as never);
  const healthComponents = new HealthComponentsService(health, probe, embedder, intent, changefeed);
  return makeAdminInfraController({ adminInfra, healthComponents });
}

describe('AdminInfraController.healthComponents() — wire contract', () => {
  it('matches HealthComponentsResponseSchema', async () => {
    const parsed = HealthComponentsResponseSchema.safeParse(
      await makeController().healthComponentsView(),
    );
    if (!parsed.success) {
      throw new Error(`health/components drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});
