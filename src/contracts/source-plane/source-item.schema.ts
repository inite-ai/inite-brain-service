import { z } from 'zod';

/**
 * One catalogued item of a source connection. Its own module because both
 * source-plane.schema.ts and source-inspect.schema.ts build on it, and
 * source-plane.schema.ts re-exports the inspect contracts.
 */
export const SourceItemStateSchema = z.enum(['seen', 'fetched', 'indexed', 'gone']);

export const SourceItemSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  originUri: z.string().nullable(),
  path: z.string().nullable(),
  title: z.string().nullable(),
  mediaType: z.string().nullable(),
  size: z.number().int().nullable(),
  revision: z.string().nullable(),
  fetchedRevision: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  documentId: z.string().nullable(),
  assetId: z.string().nullable(),
  episodeId: z.string().nullable(),
  state: SourceItemStateSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  goneAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Progressive indexing (W6): how often a query matched this row's title or path. */
  hitCount: z.number().int(),
  /** Set = the row was fetched on demand after a hit, rather than by a walk. */
  deepenedAt: z.string().nullable(),
});
export type SourceItem = z.infer<typeof SourceItemSchema>;
