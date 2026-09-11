import { z } from 'zod';

/**
 * Wire contracts for file-shaped memory — the storage behind Anthropic's
 * memory tool (`memory_20250818`).
 *
 * Paths travel in the BODY on every route, including the reads. They
 * carry slashes, and a path in the URL means `/memories/a%2Fb` and
 * `/memories/a/b` can disagree about identity — which, with the row
 * fence keyed on (path, userId), is an access-control question rather
 * than a cosmetic one.
 *
 * `str_replace` and `insert` are deliberately absent. They are
 * read-modify-write on exact text, and the adapter performs them against
 * the content these routes return; putting them here would make brain
 * own a merge policy it cannot get right.
 */

/** Absolute path under `/memories`, traversal-free. Enforced server-side. */
export const MemoryFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Absolute path under /memories, e.g. /memories/user_prefs.md');

export const MemoryFileReadRequestSchema = z.strictObject({
  path: MemoryFilePathSchema,
  /** Per-user memory scope (0055). Omitted = the workspace-wide file. */
  userId: z.string().max(200).optional(),
});

export const MemoryFileListRequestSchema = z.strictObject({
  /** Directory prefix. Defaults to `/memories`. */
  prefix: MemoryFilePathSchema.optional(),
  userId: z.string().max(200).optional(),
});

export const MemoryFileWriteRequestSchema = z.strictObject({
  path: MemoryFilePathSchema,
  /** Stored verbatim — no normalisation; str_replace depends on it. */
  content: z.string().max(100_000),
  userId: z.string().max(200).optional(),
});

export const MemoryFileRenameRequestSchema = z.strictObject({
  path: MemoryFilePathSchema,
  newPath: MemoryFilePathSchema,
  userId: z.string().max(200).optional(),
});

export const MemoryFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  updatedAt: z.string(),
});

export const MemoryFileListResponseSchema = z.object({
  paths: z.array(z.string()),
});

export const MemoryFileDeleteResponseSchema = z.object({
  /** Rows removed — more than one when the path named a directory. */
  deleted: z.number(),
});

export type MemoryFileReadRequest = z.infer<typeof MemoryFileReadRequestSchema>;
export type MemoryFileWriteRequest = z.infer<typeof MemoryFileWriteRequestSchema>;
