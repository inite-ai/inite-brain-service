import { z } from 'zod';

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
});

export const PacksListResponseSchema = z.object({
  available: z.array(AvailablePackSchema),
  installed: z.array(InstalledPackSchema),
});

export const InstallPackResponseSchema = z.object({
  packId: z.string(),
  version: z.string(),
  predicatesSeeded: z.number().int().nonnegative(),
});

export const UninstallPackResponseSchema = z.object({
  packId: z.string(),
  predicatesDeprecated: z.number().int().nonnegative(),
});

export type PacksListResponse = z.infer<typeof PacksListResponseSchema>;
export type InstallPackResponse = z.infer<typeof InstallPackResponseSchema>;
export type UninstallPackResponse = z.infer<typeof UninstallPackResponseSchema>;
