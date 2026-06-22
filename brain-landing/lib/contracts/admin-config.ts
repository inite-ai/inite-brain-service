import { z } from 'zod'

/**
 * Wire contract for GET /v1/admin/config.
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
  'misc',
])

const ConfigEntrySchema = z.object({
  key: z.string(),
  category: ConfigCategorySchema,
  currentValue: z.string(),
  defaultValue: z.string().nullable(),
  runtimeMutable: z.boolean(),
  isBooleanFlag: z.boolean(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
})

export const ConfigResponseSchema = z.object({
  entries: z.array(ConfigEntrySchema),
})

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>
