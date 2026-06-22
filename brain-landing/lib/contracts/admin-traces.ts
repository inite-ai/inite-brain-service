import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/traces.
 *
 * **Duplicate** of src/contracts/admin/traces.schema.ts.
 */

const TraceListItemSchema = z.object({
  requestId: z.string(),
  ts: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number(),
  companyId: z.string().optional(),
  errored: z
    .object({ message: z.string(), name: z.string().optional() })
    .optional(),
})

export const TracesResponseSchema = z.object({
  traces: z.array(TraceListItemSchema),
})

export type TracesResponse = z.infer<typeof TracesResponseSchema>
export type TraceListItem = z.infer<typeof TraceListItemSchema>
