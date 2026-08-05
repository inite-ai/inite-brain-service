import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/retrieval-profile.
 *
 * The RetrievalProfile the calling tenant actually resolves to — the
 * boot default overlaid with any RETRIEVAL_PROFILE_OVERRIDES entry.
 * Consumed by operators auditing per-tenant config and by the eval
 * harness, which stamps it into every report header so "which profile
 * produced this number" is recorded in the artifact itself.
 *
 * `lanes` is serialized as a sorted array (the in-process object holds
 * a ReadonlySet, which JSON.stringify would drop).
 */

export const RetrievalProfileWireSchema = z.object({
  genre: z.enum(['dialogue', 'assistant_chat', 'documents']),
  verbatimEvidence: z.enum(['off', 'shape_conditioned', 'always', 'fused']),
  dateAnchoring: z.enum(['none', 'session_date', 'absolute']),
  temporalMode: z.enum(['filter', 'overlap_boost']),
  factBudget: z.number().int(),
  quotesPerPrompt: z.number().int(),
  sourceExcerptsCap: z.number().int(),
  segmentTopK: z.number().int(),
  segmentRerank: z.boolean(),
  extraEvidenceCap: z.number().int(),
  wideProbe: z.boolean(),
  wideProbeLimit: z.number().int(),
  entityExpansion: z.boolean(),
  lanes: z.array(z.string()),
});

export const RetrievalProfileResponseSchema = z.object({
  companyId: z.string(),
  profile: RetrievalProfileWireSchema,
});

export type RetrievalProfileResponse = z.infer<
  typeof RetrievalProfileResponseSchema
>;
