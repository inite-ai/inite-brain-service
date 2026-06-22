import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/dreams/runs/:runId/emits.
 *
 * **Duplicate** of src/contracts/admin/dreams-emits.schema.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown())

export const DreamsEmitsResponseSchema = z.object({
  runId: z.string(),
  emits: z.array(OpenRecord),
})

export type DreamsEmitsResponse = z.infer<typeof DreamsEmitsResponseSchema>
