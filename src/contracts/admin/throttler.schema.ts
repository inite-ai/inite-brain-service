import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/throttler.
 *
 * Mirrors ThrottlerObservabilityService.snapshot().
 * Duplicated in brain-landing/lib/contracts/admin-throttler.ts.
 */

const ThrottledEventSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  method: z.string(),
  path: z.string(),
  bucket: z.enum(['default', 'expensive', 'unknown']),
});

const TopRouteSchema = z.object({
  route: z.string(),
  total: z.number(),
  throttled: z.number(),
  throttledRate: z.number(),
});

const TopActorSchema = z.object({
  actor: z.string(),
  total: z.number(),
  throttled: z.number(),
  throttledRate: z.number(),
});

export const ThrottlerResponseSchema = z.object({
  topRoutes: z.array(TopRouteSchema),
  topActors: z.array(TopActorSchema),
  recentThrottled: z.array(ThrottledEventSchema),
});

export type ThrottlerResponse = z.infer<typeof ThrottlerResponseSchema>;
