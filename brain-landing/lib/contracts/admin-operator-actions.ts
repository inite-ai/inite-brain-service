import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/operator-actions.
 *
 * **Duplicate** of src/contracts/admin/operator-actions.schema.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown())

const OperatorActionRowSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  scopes: z.array(z.string()),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number(),
  query: OpenRecord.nullish(),
  bodySummary: OpenRecord.nullish(),
  companyId: z.string(),
})

export const OperatorActionsResponseSchema = z.object({
  rows: z.array(OperatorActionRowSchema),
})

export type OperatorActionsResponse = z.infer<
  typeof OperatorActionsResponseSchema
>
export type OperatorActionRow = z.infer<typeof OperatorActionRowSchema>
