import { z } from 'zod';

/**
 * Wire contracts for the per-tenant source registry + reputation reads
 * (/v1/admin/sources). Declared identity lives in `source_registry`;
 * computed reputation in `source_trust` (+ `source_trust_history`); both
 * are keyed by the same `vertical:recorder` sourceKey as
 * fn::source_key_of.
 */

export const SOURCE_TYPES = [
  'human',
  'website',
  'document',
  'api',
  'agent',
  'sensor',
  'system',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Operator-declared identity (source_registry row). */
export const DeclaredSourceSchema = z.object({
  sourceKey: z.string(),
  type: z.enum(SOURCE_TYPES),
  authLevel: z.number().min(0).max(1),
  owner: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeclaredSource = z.infer<typeof DeclaredSourceSchema>;

/** One learned reputation scope (source_trust row). domain null = global. */
export const TrustScopeRowSchema = z.object({
  domain: z.string().nullable(),
  agreementRate: z.number(),
  sampleCount: z.number().int(),
  winCount: z.number().int(),
  lossCount: z.number().int(),
  lastSeenAt: z.string().nullable(),
});
export type TrustScopeRow = z.infer<typeof TrustScopeRowSchema>;

/** Catalogue line: declared ⋈ learned, either side may be absent. */
export const SourceSummarySchema = z.object({
  sourceKey: z.string(),
  declared: DeclaredSourceSchema.nullable(),
  /** The global (domain-less) learned rate, when the refit has seen it. */
  globalTrust: TrustScopeRowSchema.nullable(),
  /** Number of domain-scoped reputation rows behind this source. */
  scopedDomains: z.number().int(),
  /** The requested domain's learned rate — set only when list() was asked
   *  to capture one domain (public /v1/sources?domain=). */
  domainTrust: TrustScopeRowSchema.nullable().optional(),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SourcesListResponseSchema = z.object({
  sources: z.array(SourceSummarySchema),
});
export type SourcesListResponse = z.infer<typeof SourcesListResponseSchema>;

export const SourceHistoryRowSchema = z.object({
  domain: z.string().nullable(),
  agreementRate: z.number(),
  sampleCount: z.number().int(),
  recordedAt: z.string(),
});
export type SourceHistoryRow = z.infer<typeof SourceHistoryRowSchema>;

export const SourceDetailResponseSchema = z.object({
  sourceKey: z.string(),
  declared: DeclaredSourceSchema.nullable(),
  /** All learned scopes, global first then domains alphabetically. */
  trust: z.array(TrustScopeRowSchema),
  /** Reputation-over-time trail (source_trust_history), newest first. */
  history: z.array(SourceHistoryRowSchema),
});
export type SourceDetailResponse = z.infer<typeof SourceDetailResponseSchema>;

export const DeclareSourceRequestSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  authLevel: z.number().min(0).max(1).optional(),
  owner: z.string().max(256).optional(),
  note: z.string().max(1024).optional(),
});
export type DeclareSourceRequest = z.infer<typeof DeclareSourceRequestSchema>;

export const DeclareSourceResponseSchema = z.object({
  declared: DeclaredSourceSchema,
});
export type DeclareSourceResponse = z.infer<typeof DeclareSourceResponseSchema>;

/**
 * Public projection (/v1/sources, brain:read): the trust INPUTS a consumer
 * needs to weigh a fact's trustSnapshot — declared type/authLevel and the
 * learned rates. Operator annotations (owner/note) and the registry row
 * timestamps stay on the brain:admin surface.
 */
export const PublicDeclaredSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  authLevel: z.number().min(0).max(1),
});
export type PublicDeclaredSource = z.infer<typeof PublicDeclaredSourceSchema>;

export const PublicSourceSummarySchema = z.object({
  sourceKey: z.string(),
  declared: PublicDeclaredSourceSchema.nullable(),
  globalTrust: TrustScopeRowSchema.nullable(),
  scopedDomains: z.number().int(),
  /** The requested domain's learned rate — present iff ?domain= given. */
  domainTrust: TrustScopeRowSchema.nullable().optional(),
});
export type PublicSourceSummary = z.infer<typeof PublicSourceSummarySchema>;

export const PublicSourcesListResponseSchema = z.object({
  sources: z.array(PublicSourceSummarySchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PublicSourcesListResponse = z.infer<typeof PublicSourcesListResponseSchema>;

export const PublicSourceDetailResponseSchema = z.object({
  sourceKey: z.string(),
  declared: PublicDeclaredSourceSchema.nullable(),
  /** All learned scopes, global first then domains alphabetically. */
  trust: z.array(TrustScopeRowSchema),
  /** Reputation-over-time trail, newest first, capped at 50 rows. */
  history: z.array(SourceHistoryRowSchema),
});
export type PublicSourceDetailResponse = z.infer<typeof PublicSourceDetailResponseSchema>;
