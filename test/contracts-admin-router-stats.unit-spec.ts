/**
 * Wire-contract drift guard for GET /v1/admin/router/stats.
 */
import { RouterStatsResponseSchema } from '../src/contracts/admin/router-stats.schema';
import { makeAdminController } from './helpers/admin-controllers';
import type { AdminController } from '../src/admin/admin.controller';
import type { ChatRouterCacheService } from '../src/admin/chat-router-cache.service';
import type { CollapsePatternService } from '../src/admin/collapse-pattern.service';
import type { IntentClassifierService } from '../src/admin/intent-classifier.service';
import type { EmbedderService } from '../src/ai/embedder.service';

function makeController(): AdminController {
  const routeCache = {
    stats: () => ({
      size: 5,
      hits: 100,
      misses: 20,
      hitRate: 100 / 120,
      enabled: true,
    }),
  } as unknown as ChatRouterCacheService;
  const collapsePatterns = {
    poolSize: async () => 3,
  } as unknown as CollapsePatternService;
  const intent = {
    stats: () => ({
      enabled: true,
      ready: true,
      model: 'gemma-2b-it-q4',
      askThreshold: 0.7,
      cacheSize: 10,
    }),
  } as unknown as IntentClassifierService;
  const embedder = {
    cacheStats: () => ({
      size: 100,
      inFlight: 0,
      waiting: 0,
      provider: 'bge-m3',
    }),
  } as unknown as EmbedderService;
  return makeAdminController({
    routeCache,
    collapsePatterns,
    intentClassifier: intent,
    embedder,
  });
}

describe('AdminController.routerStats() — wire contract', () => {
  it('matches RouterStatsResponseSchema', async () => {
    const parsed = RouterStatsResponseSchema.safeParse(
      await makeController().routerStats(),
    );
    if (!parsed.success) {
      throw new Error(
        `router/stats drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
  });
});
