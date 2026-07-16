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
  /** Signature validated against the HOSTING instance's trust store at
   *  publish time — a discovery badge. Install-time verification against the
   *  installing tenant's own trust store stays the security boundary. */
  verified: z.boolean().default(false),
  yanked: z.boolean(),
  yankReason: z.string().nullable(),
  publishedAt: z.string(),
  /** Installs served for THIS version (install path only — browsing and
   *  manifest inspection are not counted). */
  downloads: z.number().int().nonnegative().default(0),
  /** Upstream registry base URL this version was mirrored from
   *  (pull-only mirror, REGISTRY_UPSTREAM_URL). Absent = locally published. */
  origin: z.string().optional(),
});

/** One pack in a catalogue listing — its latest installable version + counts. */
export const RegistryPackSummarySchema = z.object({
  packId: z.string(),
  latestVersion: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  publisher: z.string().nullable(),
  signed: z.boolean(),
  /** verified flag of the latest installable version (see RegistryVersion). */
  verified: z.boolean().default(false),
  /** Installs served, summed across ALL of the pack's versions. */
  downloads: z.number().int().nonnegative().default(0),
  /** publishedAt of the latest installable version (ISO 8601). */
  publishedAt: z.string().optional(),
  versionCount: z.number().int().nonnegative(),
  /** origin of the latest installable version (see RegistryVersion). */
  origin: z.string().optional(),
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

/**
 * SPEC MIRROR of the DomainPackManifest TS interface
 * (src/ai/domain-packs/manifest.ts) for docs/openapi.json. Deliberately
 * loose (open object, opaque nested shapes) — runtime validation is the
 * manifest validator on the install/publish path, never this schema.
 */
export const DomainPackManifestSchema = z.looseObject({
  id: z.string().describe('snake_case pack id, no `__`.'),
  version: z.string().describe('semver MAJOR.MINOR.PATCH.'),
  description: z.string(),
  predicates: z.array(z.record(z.string(), z.unknown())),
  extractionProfile: z.record(z.string(), z.unknown()).optional(),
  evalFixtures: z.array(z.record(z.string(), z.unknown())).optional(),
  seedDocuments: z.array(z.record(z.string(), z.unknown())).optional(),
  signature: z.string().optional().describe(
    'ed25519 signature (base64) over the canonical manifest sans this field.',
  ),
  publisher: z.string().optional(),
  indexer: z.record(z.string(), z.unknown()).optional(),
});

export const PublishPackRequestSchema = z.object({
  manifest: DomainPackManifestSchema,
  keywords: z.array(z.string()).optional(),
  expectedChecksum: z.string().optional(),
});

export const YankPackRequestSchema = z.object({
  reason: z.string().optional(),
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
export type DomainPackManifestWire = z.infer<typeof DomainPackManifestSchema>;
export type PublishPackRequest = z.infer<typeof PublishPackRequestSchema>;
export type YankPackRequest = z.infer<typeof YankPackRequestSchema>;
export type PublishPackResponse = z.infer<typeof PublishPackResponseSchema>;
export type YankPackResponse = z.infer<typeof YankPackResponseSchema>;
