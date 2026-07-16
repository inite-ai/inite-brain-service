import { z } from 'zod'

/**
 * Wire contracts for the per-tenant source registry + reputation reads
 * (/v1/admin/sources).
 *
 * **Duplicate** of src/contracts/sources/sources.schema.ts (admin
 * projection — the public /v1/sources shapes are not mirrored here).
 */

export const SOURCE_TYPES = [
  'human',
  'website',
  'document',
  'api',
  'agent',
  'sensor',
  'system',
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Operator-declared identity (source_registry row). */
export const DeclaredSourceSchema = z.object({
  sourceKey: z.string(),
  type: z.enum(SOURCE_TYPES),
  authLevel: z.number().min(0).max(1),
  owner: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One learned reputation scope (source_trust row). domain null = global. */
export const TrustScopeRowSchema = z.object({
  domain: z.string().nullable(),
  agreementRate: z.number(),
  sampleCount: z.number().int(),
  winCount: z.number().int(),
  lossCount: z.number().int(),
  lastSeenAt: z.string().nullable(),
})

/** Catalogue line: declared ⋈ learned, either side may be absent. */
export const SourceSummarySchema = z.object({
  sourceKey: z.string(),
  declared: DeclaredSourceSchema.nullable(),
  globalTrust: TrustScopeRowSchema.nullable(),
  scopedDomains: z.number().int(),
  domainTrust: TrustScopeRowSchema.nullable().optional(),
})

export const SourcesListResponseSchema = z.object({
  sources: z.array(SourceSummarySchema),
})

export const SourceHistoryRowSchema = z.object({
  domain: z.string().nullable(),
  agreementRate: z.number(),
  sampleCount: z.number().int(),
  recordedAt: z.string(),
})

export const SourceDetailResponseSchema = z.object({
  sourceKey: z.string(),
  declared: DeclaredSourceSchema.nullable(),
  /** All learned scopes, global first then domains alphabetically. */
  trust: z.array(TrustScopeRowSchema),
  /** Reputation-over-time trail, newest first. */
  history: z.array(SourceHistoryRowSchema),
})

export const DeclareSourceResponseSchema = z.object({
  declared: DeclaredSourceSchema,
})

export type DeclaredSource = z.infer<typeof DeclaredSourceSchema>
export type TrustScopeRow = z.infer<typeof TrustScopeRowSchema>
export type SourceSummary = z.infer<typeof SourceSummarySchema>
export type SourcesListResponse = z.infer<typeof SourcesListResponseSchema>
export type SourceHistoryRow = z.infer<typeof SourceHistoryRowSchema>
export type SourceDetailResponse = z.infer<typeof SourceDetailResponseSchema>
export type DeclareSourceResponse = z.infer<typeof DeclareSourceResponseSchema>
