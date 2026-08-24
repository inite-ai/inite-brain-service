import { z } from 'zod';

/**
 * Wire contracts for write-side admin endpoints (POST / DELETE).
 *
 * Symmetric to read-side: pin the response shape per endpoint so the
 * BFF can parse-at-boundary. Request body validation is a separate
 * concern (Nest already runs class-validator on DTOs); this file is
 * strictly outputs.
 *
 * Most maintenance endpoints return an `{ accepted: true, ... }`
 * envelope — the runId/jobType discriminator carries the actual
 * payload. They look interchangeable but each pins a different set
 * of follow-up fields, so each gets its own schema.
 *
 * Duplicated in brain-landing/lib/contracts/admin-write-responses.ts.
 */

// ── DELETE responses ─────────────────────────────────────────────

export const DropTenantResponseSchema = z.object({
  dropped: z.string(),
});

export const DlqDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});

export const PredicateDeprecateResponseSchema = z.object({
  deprecated: z.string(),
});

// ── POST accepted-envelope responses ─────────────────────────────

export const JobCancelResponseSchema = z.object({
  cancelRequested: z.boolean(),
});

export const AcceptedDreamsResponseSchema = z.object({
  accepted: z.literal(true),
  jobType: z.literal('dreams'),
  companyId: z.string(),
});

export const AcceptedCompactionResponseSchema = z.object({
  accepted: z.literal(true),
  jobType: z.literal('compaction'),
  tenants: z.array(z.string()),
});

export const AcceptedCalibrationRefitResponseSchema = z.object({
  accepted: z.literal(true),
  jobs: z.array(z.string()),
});

export const AcceptedReindexResponseSchema = z.object({
  accepted: z.literal(true),
  runId: z.string(),
});

export const AcceptedScenariosBatchResponseSchema = z.object({
  accepted: z.literal(true),
  runId: z.string(),
  scenarioCount: z.number(),
});

export const ChangefeedDrainResponseSchema = z.object({
  consumed: z.record(z.string(), z.number()),
  pendingRemaining: z.number(),
  tenants: z.number(),
});

// ── POST mutation envelopes ──────────────────────────────────────

// Reuse the predicate definition shape from the read-side contract.
// We don't import it here to keep the file self-contained — re-declare
// the relevant subset. Drift across the two definitions is caught by
// the predicates list test (same shape goes through that schema).
const PredicateDatatypeSchema = z.enum(['string', 'number', 'date', 'datetime', 'enum', 'json']);
const SemanticsSchema = z.enum(['append_only', 'single_active', 'bitemporal']);
const PiiClassSchema = z.enum(['none', 'identifier', 'behavioral', 'text', 'sensitive']);
const PredicateStatusSchema = z.enum(['active', 'proposed', 'aliased', 'deprecated']);
const PredicateCreatedBySchema = z.enum(['system', 'admin', 'llm_auto', 'migration']);

const PredicateDefinitionSchema = z.object({
  predicateId: z.string(),
  displayLabel: z.string(),
  description: z.string(),
  datatype: PredicateDatatypeSchema,
  semantics: SemanticsSchema,
  decayHalfLifeDays: z.number().nullable(),
  piiClass: PiiClassSchema,
  requiresScope: z.string().optional(),
  parentPredicateId: z.string().optional(),
  subjectClasses: z.array(z.string()).optional(),
  allowedValues: z.array(z.string()).optional(),
  status: PredicateStatusSchema,
  aliasedTo: z.string().optional(),
  createdBy: PredicateCreatedBySchema,
});

export const PredicateMutationResponseSchema = z.object({
  predicate: PredicateDefinitionSchema,
});

// ── POST complex responses ───────────────────────────────────────

const DedupIdentityLinkSchema = z.object({
  survivorId: z.string(),
  loserId: z.string(),
  cosine: z.number(),
});

const DedupResultSchema = z.object({
  suspectsEvaluated: z.number(),
  llmJudgements: z.number(),
  identityLinksCreated: z.number(),
  unsurePairs: z.number(),
  identityLinks: z.array(DedupIdentityLinkSchema),
});

const ResolverResolutionSchema = z.object({
  winnerFactId: z.string(),
  loserFactId: z.string(),
  predicate: z.string(),
  entityId: z.string(),
  winnerObject: z.string(),
  loserObject: z.string(),
});

const ResolverResultSchema = z.object({
  pairsConsidered: z.number(),
  llmJudgements: z.number(),
  resolutionsApplied: z.number(),
  unsurePairs: z.number(),
  resolutions: z.array(ResolverResolutionSchema),
});

export const DreamsRunResponseSchema = z.object({
  companyId: z.string(),
  durationSeconds: z.number(),
  dedup: DedupResultSchema.optional(),
  resolve: ResolverResultSchema.optional(),
  summarized: z.boolean().optional(),
  error: z.string().optional(),
});

export const ReindexRunResponseSchema = z.object({
  tenantsScanned: z.number(),
  factsScanned: z.number(),
  factsUpdated: z.number(),
  durationMs: z.number(),
  dryRun: z.boolean(),
  provider: z.string(),
});

// ── Scenarios + baselines write responses ────────────────────────

// ScenarioRunOutcome — heavy. Pin top-level only; queryResults /
// memoryAssertionResults / identityMergeResult kept liberal because
// they're test-defined per scenario and consumed by the eval UI
// generically. Drift on metrics keys IS pinned, though, since those
// drive the dashboard recall numbers.
const OpenRecord = z.record(z.string(), z.unknown());

const ScenarioMetricsSchema = z.object({
  recallAt1: z.number(),
  recallAt5: z.number(),
  queries: z.number(),
  passes: z.number(),
  memoryAssertionsPassed: z.number(),
  memoryAssertionsTotal: z.number(),
  piiGatingPassed: z.number(),
  piiGatingTotal: z.number(),
});

const SetupSummarySchema = z.object({
  facts: z.number(),
  mentions: z.number(),
  links: z.number(),
  retracts: z.number(),
  forgets: z.number(),
  errors: z.array(
    z.object({
      step: z.number(),
      kind: z.string(),
      error: z.string(),
    }),
  ),
});

export const ScenarioRunOutcomeSchema = z.object({
  scenarioId: z.string(),
  vertical: z.string(),
  companyId: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  passed: z.boolean(),
  setupSummary: SetupSummarySchema,
  queryResults: z.array(OpenRecord),
  memoryAssertionResults: z.array(OpenRecord),
  identityMergeResult: OpenRecord.optional(),
  synthesizeSkipped: z.object({ count: z.number(), reason: z.string() }).optional(),
  metrics: ScenarioMetricsSchema,
});

export const ScenariosBatchResponseSchema = z.object({
  outcomes: z.array(ScenarioRunOutcomeSchema),
});

const BaselineDiffMetricSchema = z.object({
  scenarioId: z.string(),
  metric: z.enum(['recallAt1', 'recallAt5']),
  baseline: z.number(),
  current: z.number(),
  delta: z.number(),
  verdict: z.enum(['regression', 'improved', 'stable']),
});

export const BaselineSaveResponseSchema = z.object({
  name: z.string(),
  savedAt: z.string(),
  scenarios: z.number(),
  meanRecallAt1: z.number(),
});

export const BaselineDiffResponseSchema = z.object({
  baseline: z.string(),
  entries: z.array(BaselineDiffMetricSchema),
});

// ── Type exports ─────────────────────────────────────────────────

export type DropTenantResponse = z.infer<typeof DropTenantResponseSchema>;
export type DlqDeleteResponse = z.infer<typeof DlqDeleteResponseSchema>;
export type PredicateDeprecateResponse = z.infer<typeof PredicateDeprecateResponseSchema>;
export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>;
export type AcceptedDreamsResponse = z.infer<typeof AcceptedDreamsResponseSchema>;
export type AcceptedCompactionResponse = z.infer<typeof AcceptedCompactionResponseSchema>;
export type AcceptedCalibrationRefitResponse = z.infer<
  typeof AcceptedCalibrationRefitResponseSchema
>;
export type AcceptedReindexResponse = z.infer<typeof AcceptedReindexResponseSchema>;
export type AcceptedScenariosBatchResponse = z.infer<typeof AcceptedScenariosBatchResponseSchema>;
export type ChangefeedDrainResponse = z.infer<typeof ChangefeedDrainResponseSchema>;
export type PredicateMutationResponse = z.infer<typeof PredicateMutationResponseSchema>;
export type DreamsRunResponse = z.infer<typeof DreamsRunResponseSchema>;
export type ReindexRunResponse = z.infer<typeof ReindexRunResponseSchema>;
export type ScenarioRunOutcomeResponse = z.infer<typeof ScenarioRunOutcomeSchema>;
export type ScenariosBatchResponse = z.infer<typeof ScenariosBatchResponseSchema>;
export type BaselineSaveResponse = z.infer<typeof BaselineSaveResponseSchema>;
export type BaselineDiffResponse = z.infer<typeof BaselineDiffResponseSchema>;
