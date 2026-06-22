import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/traces/:requestId.
 *
 * Mirrors DebugTraceSnapshot from common/debug-trace-core.ts. The
 * listing surface (/v1/admin/traces) intentionally omits spans /
 * artifacts; this detail endpoint includes them.
 *
 * Duplicated in brain-landing/lib/contracts/admin-trace-detail.ts.
 */

const DebugSpanSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  startedAt: z.number(),
  durationMs: z.number().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const DebugArtifactSchema = z.object({
  spanId: z.string().optional(),
  name: z.string(),
  ts: z.number(),
  value: z.unknown(),
});

export const TraceDetailResponseSchema = z.object({
  requestId: z.string(),
  ts: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number(),
  companyId: z.string().optional(),
  spans: z.array(DebugSpanSchema),
  artifacts: z.array(DebugArtifactSchema),
  errored: z
    .object({ message: z.string(), name: z.string().optional() })
    .optional(),
});

export type TraceDetailResponse = z.infer<typeof TraceDetailResponseSchema>;
