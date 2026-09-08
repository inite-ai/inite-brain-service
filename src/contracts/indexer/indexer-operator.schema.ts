import { z } from 'zod';

/**
 * Wire contracts for the OPERATOR view over a tenant's indexers
 * (`/v1/admin/indexers`, scope `brain:admin`, flag
 * INDEXER_OPERATOR_VIEW_ENABLED).
 *
 * An indexer's identity IS its pack (`indexerId === packId`; the
 * descriptor lives inside the signed pack manifest), and the run ledger
 * `indexer_run` is keyed by (docId, packId, packVersion). Until now the
 * only HTTP surface over that ledger was GET /v1/indexer/work — the
 * external poller's own work queue, not an operator's view. This is the
 * read-only view: which indexers a tenant has, and how their runs are
 * doing over a bounded recent window.
 *
 * Read-only by construction: no verb here mutates a run, a candidate, or
 * a pack installation.
 */

/** Indexer execution modes (mirrors IndexerDescriptor.mode). */
export const IndexerModeSchema = z.enum(['virtual', 'dedicated', 'external']);

/** Where the pack came from: shipped with the service, or installed. */
export const IndexerSourceSchema = z.enum(['builtin', 'installed']);

/** The bounded window every aggregate on this surface is computed over. */
export const IndexerWindowSchema = z.object({
  /** Inclusive lower bound (ISO-8601) on `indexer_run.createdAt`. */
  since: z.string(),
  /** Window width in days (clamped server-side). */
  days: z.number().int().positive(),
  /** Per-indexer cap on runs read; true when the cap was hit. */
  runCap: z.number().int().positive(),
});

/** Run-status tallies over the window (statuses of migration 0049). */
export const IndexerRunTotalsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

/** Candidate-status tallies over the same window's runs (migration 0049). */
export const IndexerCandidateTotalsSchema = z.object({
  /** Every candidate staged by the window's runs ("submitted"). */
  submitted: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  committed: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
});

/** Per-run extraction stats as finalizeRun recorded them. */
export const IndexerRunStatsSchema = z.object({
  chunks: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

/** One `indexer_run` row as an operator reads it. */
export const IndexerRunSummarySchema = z.object({
  runId: z.string(),
  documentId: z.string(),
  packVersion: z.string(),
  status: z.string(),
  /** true = an external work item (pull API), not an in-process run. */
  external: z.boolean(),
  /** `createdAt` — also the claim-lease clock for external runs. */
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  stats: IndexerRunStatsSchema.nullable(),
  /** Failure message as the ledger recorded it (capped server-side). */
  error: z.string().nullable(),
  candidates: IndexerCandidateTotalsSchema,
});

/**
 * External-publisher liveness, derived from the ledger — there is no
 * separate poll journal, so `lastClaimAt` (the newest claim over the
 * window) is the honest proxy for "the publisher is polling".
 */
export const IndexerExternalHealthSchema = z.object({
  /** Trust-store key declared by the manifest, when it declares one. */
  publisher: z.string().nullable(),
  /** Work items still waiting to be claimed (window-bounded). */
  pendingWork: z.number().int().nonnegative(),
  /** Oldest unclaimed work item in the window, if any. */
  oldestPendingAt: z.string().nullable(),
  /** Newest claim seen in the window — the poll proxy. */
  lastClaimAt: z.string().nullable(),
  /** lastClaimAt within `polledWithinHours`. */
  polledRecently: z.boolean(),
  polledWithinHours: z.number().int().positive(),
});

/** One indexer (= one pack carrying an `indexer` descriptor). */
export const IndexerOverviewSchema = z.object({
  /** Pack id — the indexer's identity. */
  packId: z.string(),
  /** Version the tenant currently runs (installed row, or builtin). */
  packVersion: z.string(),
  mode: IndexerModeSchema,
  source: IndexerSourceSchema,
  description: z.string(),
  /** Install timestamp for `installed` packs; null for builtins. */
  installedAt: z.string().nullable(),
  /** Most recent run in the window, or null when the indexer is idle. */
  lastRun: IndexerRunSummarySchema.nullable(),
  runs: IndexerRunTotalsSchema,
  candidates: IndexerCandidateTotalsSchema,
  /** Present only for `external` mode; null otherwise. */
  external: IndexerExternalHealthSchema.nullable(),
  /** true = the per-indexer run cap was hit, so tallies are partial. */
  truncated: z.boolean(),
});

export const IndexerOverviewListResponseSchema = z.object({
  tenant: z.string(),
  window: IndexerWindowSchema,
  indexers: z.array(IndexerOverviewSchema),
});

export const IndexerRunListResponseSchema = z.object({
  tenant: z.string(),
  packId: z.string(),
  window: IndexerWindowSchema,
  runs: z.array(IndexerRunSummarySchema),
  truncated: z.boolean(),
});

export type IndexerMode = z.infer<typeof IndexerModeSchema>;
export type IndexerSource = z.infer<typeof IndexerSourceSchema>;
export type IndexerWindow = z.infer<typeof IndexerWindowSchema>;
export type IndexerRunTotals = z.infer<typeof IndexerRunTotalsSchema>;
export type IndexerCandidateTotals = z.infer<typeof IndexerCandidateTotalsSchema>;
export type IndexerRunStats = z.infer<typeof IndexerRunStatsSchema>;
export type IndexerRunSummary = z.infer<typeof IndexerRunSummarySchema>;
export type IndexerExternalHealth = z.infer<typeof IndexerExternalHealthSchema>;
export type IndexerOverview = z.infer<typeof IndexerOverviewSchema>;
export type IndexerOverviewListResponse = z.infer<typeof IndexerOverviewListResponseSchema>;
export type IndexerRunListResponse = z.infer<typeof IndexerRunListResponseSchema>;
