/** Why the cross-encoder ran or did not for a search (search-rerank.service.ts). */
export type CrossEncoderOutcome =
  | 'invoked'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_singleton'
  | 'skipped_all_fit'
  | 'skipped_llm_orders'
  | 'fact_invoked'
  | 'fact_error';
