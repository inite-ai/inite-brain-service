import { z } from 'zod';

/**
 * Wire contract for the operator's configuration —
 * GET /v1/admin/config, PUT and DELETE /v1/admin/config/:key.
 *
 * Mirrors ConfigEntry from config-inspector.service.ts.
 * Duplicated in brain-landing/lib/contracts/admin-config.ts.
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
  'scenes',
  'conflict',
  'cost',
  'throttle',
  'jobs',
  'auth',
  'registry',
  'billing',
  'misc',
]);

const ConfigEntrySchema = z.object({
  key: z.string(),
  category: ConfigCategorySchema,
  currentValue: z.string(),
  defaultValue: z.string().nullable(),
  runtimeMutable: z.boolean(),
  isBooleanFlag: z.boolean(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  /** Whether an operator override from `platform_setting` is standing. */
  overridden: z.boolean(),
  /** What the deploy's own environment holds under the override; null when it set none, absent when nothing overrides. */
  deployValue: z.string().nullable().optional(),
  /** Whether this key may be set at all (a bootstrap key is environment-only). */
  settable: z.boolean(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  note: z.string().nullable().optional(),
});

export const ConfigResponseSchema = z.object({
  entries: z.array(ConfigEntrySchema),
  /** False when this deployment cannot store secrets (no encryption key). */
  secretsWritable: z.boolean(),
});

/** PUT /v1/admin/config/:key */
export const ConfigSetRequestSchema = z.object({
  value: z.string().max(8192),
  note: z.string().max(500).optional(),
});

export const ConfigWriteResponseSchema = z.object({
  key: z.string(),
  /** 'set' | 'cleared' | 'absent' — what the write actually did. */
  outcome: z.enum(['set', 'cleared', 'absent']),
  /** True when the value only takes effect after a restart. */
  restartRequired: z.boolean(),
});

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;
export type ConfigSetRequest = z.infer<typeof ConfigSetRequestSchema>;
export type ConfigWriteResponse = z.infer<typeof ConfigWriteResponseSchema>;
