/** How an indexer run ended, as brain_indexer_runs_total counts it. */
export type IndexerRunOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped_duplicate'
  /** Kept raw by its read depth — no extraction (read-depth.ts). */
  | 'skipped_raw'
  | 'reopened'
  | 'stale_reaped'
  | 'claim_released';
