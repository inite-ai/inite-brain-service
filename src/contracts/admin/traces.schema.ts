import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/traces.
 *
 * Mirrors TraceListItem = Omit<DebugTraceSnapshot, 'spans' | 'artifacts'>
 * — the listing surface intentionally omits the heavy span/artifact
 * payloads. Operators get those via /v1/admin/traces/:requestId
 * (covered at type level by the controller's return type; the BFF
 * doesn't parse dynamic paths in G2).
 *
 * Duplicated in brain-landing/lib/contracts/admin-traces.ts.
 */

const TraceListItemSchema = z.object({
  requestId: z.string(),
  ts: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number(),
  companyId: z.string().optional(),
  errored: z
    .object({ message: z.string(), name: z.string().optional() })
    .optional(),
});

export const TracesResponseSchema = z.object({
  traces: z.array(TraceListItemSchema),
});

export type TracesResponse = z.infer<typeof TracesResponseSchema>;
export type TraceListItem = z.infer<typeof TraceListItemSchema>;
