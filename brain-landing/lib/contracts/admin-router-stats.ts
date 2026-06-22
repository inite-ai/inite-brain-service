import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/router/stats.
 *
 * **Duplicate** of src/contracts/admin/router-stats.schema.ts.
 */

const RouteCacheStatsSchema = z.object({
  size: z.number(),
  hits: z.number(),
  misses: z.number(),
  hitRate: z.number(),
  enabled: z.boolean(),
})

const EmbedderCacheStatsSchema = z.object({
  size: z.number(),
  inFlight: z.number(),
  waiting: z.number(),
  provider: z.string(),
})

const IntentClassifierStatsSchema = z.object({
  enabled: z.boolean(),
  ready: z.boolean(),
  model: z.string(),
  askThreshold: z.number(),
  cacheSize: z.number(),
})

export const RouterStatsResponseSchema = z.object({
  tenant: z.string(),
  routeCache: RouteCacheStatsSchema,
  embedderCache: EmbedderCacheStatsSchema,
  intentClassifier: IntentClassifierStatsSchema,
  collapsePatternPoolSize: z.number(),
})

export type RouterStatsResponse = z.infer<typeof RouterStatsResponseSchema>
