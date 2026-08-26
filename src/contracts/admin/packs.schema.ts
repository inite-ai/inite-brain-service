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
  /** The stored manifest's memoryModel section (PackMemoryModel —
   *  docs/domain-packs.md); null when the pack declares none. Opaque here
   *  on purpose; runtime validation is validateMemoryModel. */
  memoryModel: z.record(z.string(), z.unknown()).nullable(),
});

export const PacksListResponseSchema = z.object({
  available: z.array(AvailablePackSchema),
  installed: z.array(InstalledPackSchema),
});

export const InstallPackRequestSchema = z.object({
  manifest: DomainPackManifestSchema,
  expectedChecksum: z.string().optional(),
  /** Explicit consent to the manifest's mcpTools section (docs/
   *  mcp-pack-tools.md). Required (400 otherwise) whenever the section is
   *  non-empty, unless a prior install already accepted the identical
   *  section — an upgrade that CHANGES it re-requires the flag. */
  acceptMcpTools: z.boolean().optional(),
  /** Explicit consent to the manifest's declared non-text modalities and
   *  raw-evidence capability (media/biometric tier, 0112). Required (400
   *  otherwise) whenever the manifest declares non-text modality
   *  processing, unless a prior install already accepted the identical
   *  media section — an upgrade that CHANGES it re-requires the flag. */
  acceptModalities: z.boolean().optional(),
});

export const InstallFromRegistryRequestSchema = z.object({
  packId: z.string(),
  /** Absent = latest non-yanked registry version. */
  version: z.string().optional(),
  /** See InstallPackRequest.acceptMcpTools — same consent gate. */
  acceptMcpTools: z.boolean().optional(),
  /** See InstallPackRequest.acceptModalities — same consent gate. */
  acceptModalities: z.boolean().optional(),
});

export const InstallPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  predicatesSeeded: z.number().int().nonnegative(),
  checksum: z.string(),
  seedDocuments: z
    .object({
      count: z.number().int().nonnegative(),
      status: z.enum([
        'enqueued',
        'enqueue_failed',
        'skipped_flag_disabled',
        'skipped_ingest_disabled',
        'skipped_no_queue',
      ]),
    })
    .optional()
    .describe(
      'Present iff the manifest ships seedDocuments — whether their document-pipeline ingest was enqueued. Install never fails because of seeds.',
    ),
  /** HMAC secret for indexer webhook pushes AND external mcpTool calls —
   *  present ONLY when freshly minted (first install of a pack that needs
   *  one). Shown once; upgrades keep the existing secret and omit this. */
  webhookSecret: z.string().optional(),
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
  failures: z
    .array(z.string())
    .describe('Human-readable reasons the fixture failed (empty when passed).'),
});

export const PackEvalReportSchema = z.object({
  packId: z.string(),
  version: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  results: z.array(PackEvalFixtureResultSchema),
});

export type InstallPackRequest = z.infer<typeof InstallPackRequestSchema>;
export type InstallFromRegistryRequest = z.infer<typeof InstallFromRegistryRequestSchema>;
export type PackEvalReportWire = z.infer<typeof PackEvalReportSchema>;
export type PacksListResponse = z.infer<typeof PacksListResponseSchema>;
export type InstallPackResponse = z.infer<typeof InstallPackResponseSchema>;
export type UninstallPackResponse = z.infer<typeof UninstallPackResponseSchema>;
