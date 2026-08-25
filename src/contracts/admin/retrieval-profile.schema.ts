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
  verbatimEvidence: z.enum(['off', 'shape_conditioned', 'always', 'fused', 'routed']),
  insightEvidence: z.enum(['off', 'routed', 'query_arc']),
  timelineEvidence: z.enum(['off', 'routed', 'scan']),
  coverageScanMode: z.enum(['brute', 'hnsw']),
  coverageLexMode: z.enum(['phrase', 'or_terms']),
  cjkSegmentation: z.boolean(),
  multilingualLaneRouting: z.boolean(),
  multilingualConflict: z.boolean(),
  answerLangGuard: z.boolean(),
  scanHnswEf: z.number().int(),
  scanHnswOverfetch: z.number().int(),
  dateAnchoring: z.enum(['none', 'session_date', 'absolute']),
  temporalMode: z.enum(['filter', 'overlap_boost']),
  factBudget: z.number().int(),
  quotesPerPrompt: z.number().int(),
  sourceExcerptsCap: z.number().int(),
  segmentTopK: z.number().int(),
  segmentRerank: z.boolean(),
  factRerank: z.boolean(),
  mentionDates: z.boolean(),
  sceneTraces: z.boolean(),
  enumStrict: z.boolean(),
  extraEvidenceCap: z.number().int(),
  wideProbe: z.boolean(),
  wideProbeLimit: z.number().int(),
  entityExpansion: z.boolean(),
  salienceScoring: z.boolean(),
  updateStoryRendering: z.boolean(),
  orderingFrame: z.boolean(),
  verifierTopicCoverage: z.boolean(),
  verifierModel: z.string(),
  digestEvidence: z.boolean(),
  digestLanes: z.enum(['all', 'summary_ku']),
  rawWindow: z.boolean(),
  rawWindowSpan: z.number().int(),
  assistantLane: z.boolean(),
  assistantLaneTopK: z.number().int(),
  assistantLaneMatch: z.string(),
  factsAsKeys: z.boolean(),
  factsAsKeysCap: z.number().int(),
  timeFilter: z.boolean(),
  dateMath: z.boolean(),
  answerConditioning: z.boolean(),
  noiseFilter: z.boolean(),
  searchLoop: z.boolean(),
  l3Escalation: z.boolean(),
  l3MaxSessions: z.number().int(),
  l3TokenCap: z.number().int(),
  abstentionCalibration: z.enum(['off', 'coverage', 'verifier', 'minicheck']),
  abstentionMinTopScore: z.number(),
  abstentionMinEvidence: z.number().int(),
  lanes: z.array(z.string()),
});

export const RetrievalProfileResponseSchema = z.object({
  companyId: z.string(),
  profile: RetrievalProfileWireSchema,
});

export type RetrievalProfileResponse = z.infer<typeof RetrievalProfileResponseSchema>;
