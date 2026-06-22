import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/migrations.
 *
 * **Duplicate** of src/contracts/admin/migrations.schema.ts.
 */

const ManifestEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
})

const TenantStateSchema = z.object({
  companyId: z.string(),
  applied: z.array(z.string()),
  pending: z.array(z.string()),
})

export const MigrationsResponseSchema = z.object({
  manifest: z.array(ManifestEntrySchema),
  perTenant: z.array(TenantStateSchema),
  driftDetected: z.boolean(),
})

export type MigrationsResponse = z.infer<typeof MigrationsResponseSchema>
export type Migration = z.infer<typeof ManifestEntrySchema>
export type TenantState = z.infer<typeof TenantStateSchema>
