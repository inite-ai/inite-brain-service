import { z } from 'zod'
import { AdminForgottenRowSchema } from './admin-overview'

/**
 * Wire contract for GET /v1/admin/forgotten.
 *
 * **Duplicate** of src/contracts/admin/forgotten.schema.ts.
 */

export const ForgottenResponseSchema = z.object({
  rows: z.array(AdminForgottenRowSchema),
})

export type ForgottenResponse = z.infer<typeof ForgottenResponseSchema>
