import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/health/components.
 *
 * **Duplicate** of src/contracts/admin/health-components.schema.ts.
 */

const ComponentSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'warming', 'degraded', 'disabled', 'unreachable']),
  latencyMs: z.number().optional(),
  message: z.string().optional(),
})

export const HealthComponentsResponseSchema = z.object({
  generatedAt: z.string(),
  components: z.array(ComponentSchema),
})

export type HealthComponentsResponse = z.infer<
  typeof HealthComponentsResponseSchema
>
export type HealthComponent = z.infer<typeof ComponentSchema>
