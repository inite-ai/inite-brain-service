import { z } from 'zod';
import { DomainPackManifestSchema } from '../registry/registry.schema';

/**
 * Wire contracts for the Domain Pack admin surface (/v1/admin/packs).
 */

export const AvailablePackSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  predicateCount: z.number().int().nonnegative(),
  builtin: z.boolean(),
});

export const InstalledPackSchema = z.object({
  packId: z.string(),
  version: z.string(),
  installedAt: z.string(),
  predicateCount: z.number().int().nonnegative(),
  checksum: z.string().nullable(),
});

export const PacksListResponseSchema = z.object({
  available: z.array(AvailablePackSchema),
  installed: z.array(InstalledPackSchema),
});

export const InstallPackRequestSchema = z.object({
  manifest: DomainPackManifestSchema,
  expectedChecksum: z.string().optional(),
});

export const InstallFromRegistryRequestSchema = z.object({
  packId: z.string(),
  /** Absent = latest non-yanked registry version. */
  version: z.string().optional(),
});

export const InstallPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  predicatesSeeded: z.number().int().nonnegative(),
  checksum: z.string(),
});

export const UninstallPackResponseSchema = z.object({
  packId: z.string(),
  predicatesDeprecated: z.number().int().nonnegative(),
});

/** SPEC MIRROR of PackEvalReport / EvalFixtureResult
 *  (src/ai/domain-packs/eval-fixture.ts) for docs/openapi.json. */
export const PackEvalFixtureResultSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  failures: z.array(z.string()).describe(
    'Human-readable reasons the fixture failed (empty when passed).',
  ),
});

export const PackEvalReportSchema = z.object({
  packId: z.string(),
  version: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  results: z.array(PackEvalFixtureResultSchema),
});

export type InstallPackRequest = z.infer<typeof InstallPackRequestSchema>;
export type InstallFromRegistryRequest = z.infer<
  typeof InstallFromRegistryRequestSchema
>;
export type PackEvalReportWire = z.infer<typeof PackEvalReportSchema>;
export type PacksListResponse = z.infer<typeof PacksListResponseSchema>;
export type InstallPackResponse = z.infer<typeof InstallPackResponseSchema>;
export type UninstallPackResponse = z.infer<typeof UninstallPackResponseSchema>;
