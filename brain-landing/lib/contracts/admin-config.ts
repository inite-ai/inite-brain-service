import { z } from 'zod'

/**
 * Wire contract for the operator's configuration —
 * GET /v1/admin/config, PUT and DELETE /v1/admin/config/:key.
 *
 * **Duplicate** of src/contracts/admin/config.schema.ts.
 */

const ConfigCategorySchema = z.enum([
  'pipeline',
  'extractor',
  'embedder',
  'dreams',
  'compaction',
  'audit',
  'router',
  'search',
  'multihop',
  'calibration',
  'conflict',
  'cost',
  'throttle',
  'jobs',
  'auth',
  'registry',
  'billing',
  'misc',
])

/**
 * Canonical category list in display order. Panels must derive their
 * ordering from this instead of hardcoding a copy (guarded by
 * __tests__/admin-drift.test.ts).
 */
export const CONFIG_CATEGORIES = ConfigCategorySchema.options

const ConfigEntrySchema = z.object({
  key: z.string(),
  category: ConfigCategorySchema,
  currentValue: z.string(),
  defaultValue: z.string().nullable(),
  runtimeMutable: z.boolean(),
  isBooleanFlag: z.boolean(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  overridden: z.boolean(),
  deployValue: z.string().nullable().optional(),
  settable: z.boolean(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  note: z.string().nullable().optional(),
})

export const ConfigResponseSchema = z.object({
  entries: z.array(ConfigEntrySchema),
  secretsWritable: z.boolean(),
})

export const ConfigWriteResponseSchema = z.object({
  key: z.string(),
  outcome: z.enum(['set', 'cleared', 'absent']),
  restartRequired: z.boolean(),
})

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>
export type ConfigWriteResponse = z.infer<typeof ConfigWriteResponseSchema>
