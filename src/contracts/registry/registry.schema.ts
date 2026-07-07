import { z } from 'zod';

/**
 * Wire contracts for the GLOBAL Domain Pack registry — discovery reads
 * (/v1/registry) + publish/yank (/v1/admin/registry). See docs/domain-packs.md.
 */

/** One published version's discovery metadata (no manifest body). */
export const RegistryVersionSchema = z.object({
  packId: z.string(),
  version: z.string(),
  checksum: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  publisher: z.string().nullable(),
  signed: z.boolean(),
  yanked: z.boolean(),
  yankReason: z.string().nullable(),
  publishedAt: z.string(),
});

/** One pack in a catalogue listing — its latest installable version + counts. */
export const RegistryPackSummarySchema = z.object({
  packId: z.string(),
  latestVersion: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  publisher: z.string().nullable(),
  signed: z.boolean(),
  versionCount: z.number().int().nonnegative(),
});

export const RegistryListResponseSchema = z.object({
  packs: z.array(RegistryPackSummarySchema),
});

export const RegistryVersionsResponseSchema = z.object({
  packId: z.string(),
  latestVersion: z.string().nullable(),
  versions: z.array(RegistryVersionSchema),
});

/** A resolved manifest for install/inspection (carries the full body). */
export const RegistryManifestResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  checksum: z.string(),
  yanked: z.boolean(),
  manifest: z.record(z.string(), z.unknown()),
});

export const PublishPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  checksum: z.string(),
  /** false when the identical (packId, version, checksum) was already present
   *  (idempotent republish); true when a new version row was created. */
  created: z.boolean(),
});

export const YankPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  yanked: z.boolean(),
});

export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;
export type RegistryPackSummary = z.infer<typeof RegistryPackSummarySchema>;
export type RegistryListResponse = z.infer<typeof RegistryListResponseSchema>;
export type RegistryVersionsResponse = z.infer<
  typeof RegistryVersionsResponseSchema
>;
export type RegistryManifestResponse = z.infer<
  typeof RegistryManifestResponseSchema
>;
export type PublishPackResponse = z.infer<typeof PublishPackResponseSchema>;
export type YankPackResponse = z.infer<typeof YankPackResponseSchema>;
