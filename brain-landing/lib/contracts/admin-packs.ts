import { z } from 'zod'

/**
 * Wire contracts for the Domain Pack admin surface (/v1/admin/packs).
 *
 * **Duplicate** of src/contracts/admin/packs.schema.ts (response shapes —
 * requests are built by the panel and validated by the backend).
 */

export const AvailablePackSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  predicateCount: z.number().int().nonnegative(),
  builtin: z.boolean(),
})

export const InstalledPackSchema = z.object({
  packId: z.string(),
  version: z.string(),
  installedAt: z.string(),
  predicateCount: z.number().int().nonnegative(),
  checksum: z.string().nullable(),
})

export const PacksListResponseSchema = z.object({
  available: z.array(AvailablePackSchema),
  installed: z.array(InstalledPackSchema),
})

export const SeedIngestStatusSchema = z.enum([
  'enqueued',
  'enqueue_failed',
  'skipped_flag_disabled',
  'skipped_ingest_disabled',
  'skipped_no_queue',
])

export const InstallPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  predicatesSeeded: z.number().int().nonnegative(),
  checksum: z.string(),
  /** Present iff the manifest ships seedDocuments. */
  seedDocuments: z
    .object({
      count: z.number().int().nonnegative(),
      status: SeedIngestStatusSchema,
    })
    .optional(),
  /** HMAC secret — present ONLY when freshly minted; shown once. */
  webhookSecret: z.string().optional(),
})

export const UninstallPackResponseSchema = z.object({
  packId: z.string(),
  predicatesDeprecated: z.number().int().nonnegative(),
})

export const PackEvalFixtureResultSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  failures: z.array(z.string()),
})

export const PackEvalReportSchema = z.object({
  packId: z.string(),
  version: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  results: z.array(PackEvalFixtureResultSchema),
})

export type AvailablePack = z.infer<typeof AvailablePackSchema>
export type InstalledPack = z.infer<typeof InstalledPackSchema>
export type PacksListResponse = z.infer<typeof PacksListResponseSchema>
export type InstallPackResponse = z.infer<typeof InstallPackResponseSchema>
export type UninstallPackResponse = z.infer<typeof UninstallPackResponseSchema>
export type PackEvalReport = z.infer<typeof PackEvalReportSchema>
