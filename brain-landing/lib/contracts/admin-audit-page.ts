import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/audit.
 *
 * **Duplicate** of src/contracts/admin/audit-page.schema.ts.
 */

const OpenRecord = z.record(z.string(), z.unknown())

const AuditEventRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  source: z.string(),
  recordId: z.string(),
  op: z.string(),
  ts: z.string(),
  versionstamp: z.number(),
  before: OpenRecord.nullish(),
  after: OpenRecord.nullish(),
  consumedBy: z.string(),
})

export const AuditPageResponseSchema = z.object({
  events: z.array(AuditEventRowSchema),
  totalsBySource: z.record(z.string(), z.number()),
  totalsByOp: z.record(z.string(), z.number()),
  hourly: z.array(z.object({ hour: z.string(), count: z.number() })),
})

export type AuditPageResponse = z.infer<typeof AuditPageResponseSchema>
export type AuditEventRow = z.infer<typeof AuditEventRowSchema>
