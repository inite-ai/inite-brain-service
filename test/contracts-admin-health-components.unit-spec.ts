/**
 * Wire-contract drift guard for GET /v1/admin/health/components.
 */
import { HealthComponentsResponseSchema } from '../src/contracts/admin/health-components.schema';
import { AdminInfraController } from '../src/admin/admin-infra.controller';
import { AdminInfraService } from '../src/admin/admin-infra.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { IntentClassifierService } from '../src/admin/intent-classifier.service';
import type { ChangefeedConsumerService } from '../src/audit/changefeed-consumer.service';
import type { ConfigService } from '@nestjs/config';

function makeController(): AdminInfraController {
  const surreal = {
    ping: async () => true,
  } as unknown as SurrealService;
  const embedder = {
    isReady: () => true,
    cacheStats: () => ({ provider: 'bge-m3', size: 100 }),
  } as unknown as EmbedderService;
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
  const config = {
    get: <T>(_k: string, dflt?: T) => dflt,
  } as unknown as ConfigService;
  const undef = undefined as unknown as never;
  const adminInfra = new AdminInfraService(surreal, undef);
  return new AdminInfraController(
    adminInfra,
    embedder,
    intent,
    changefeed,
    undef,
    undef,
    config,
  );
}

describe('AdminInfraController.healthComponents() — wire contract', () => {
  it('matches HealthComponentsResponseSchema', async () => {
    const parsed = HealthComponentsResponseSchema.safeParse(
      await makeController().healthComponents(),
    );
    if (!parsed.success) {
      throw new Error(
        `health/components drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
  });
});
