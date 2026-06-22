import { z } from 'zod'
import { AdminDeadLetterRowSchema } from './admin-overview'

/**
 * Wire contract for GET /v1/admin/dlq.
 *
 * **Duplicate** of src/contracts/admin/dlq.schema.ts.
 */

export const DlqResponseSchema = z.object({
  rows: z.array(AdminDeadLetterRowSchema),
})

export type DlqResponse = z.infer<typeof DlqResponseSchema>
