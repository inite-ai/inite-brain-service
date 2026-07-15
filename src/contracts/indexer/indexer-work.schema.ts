import { z } from 'zod';

/**
 * Wire contracts for the external-indexer work-discovery surface
 * (/v1/indexer/work, scope `indexer:write`). See docs/indexer-protocol.md.
 */

/** One claimable work item: a 'pending' external indexer_run. */
export const IndexerWorkItemSchema = z.object({
  runId: z.string(),
  documentId: z.string(),
  packId: z.string(),
  packVersion: z.string(),
  createdAt: z.string(),
  /** false = the document was stored without content (ungrounded flow). */
  docHasContent: z.boolean(),
});

export const IndexerWorkListResponseSchema = z.object({
  work: z.array(IndexerWorkItemSchema),
});

export const ClaimWorkResponseSchema = z.object({
  runId: z.string(),
  documentId: z.string(),
  packId: z.string(),
  packVersion: z.string(),
  /** Presented on submit/heartbeat/fail — fences a lost lease. */
  claimToken: z.string(),
  /** Heartbeat within this window or the claim is reaped as abandoned. */
  leaseSeconds: z.number().int().positive(),
});

export const HeartbeatWorkResponseSchema = z.object({
  runId: z.string(),
  leaseSeconds: z.number().int().positive(),
});

export const WorkContentChunkSchema = z.object({
  seq: z.number().int().nonnegative(),
  text: z.string(),
});

export const WorkContentResponseSchema = z.object({
  documentId: z.string(),
  kind: z.string(),
  vertical: z.string(),
  occurredAt: z.string(),
  chunkCount: z.number().int().nonnegative(),
  chunks: z.array(WorkContentChunkSchema),
});

export const FailWorkResponseSchema = z.object({
  runId: z.string(),
  /** 'released' = back to the pending pool; 'failed' = permanent skip. */
  status: z.enum(['released', 'failed']),
});

export type IndexerWorkItem = z.infer<typeof IndexerWorkItemSchema>;
export type IndexerWorkListResponse = z.infer<
  typeof IndexerWorkListResponseSchema
>;
export type ClaimWorkResponse = z.infer<typeof ClaimWorkResponseSchema>;
export type HeartbeatWorkResponse = z.infer<typeof HeartbeatWorkResponseSchema>;
export type WorkContentResponse = z.infer<typeof WorkContentResponseSchema>;
export type FailWorkResponse = z.infer<typeof FailWorkResponseSchema>;
